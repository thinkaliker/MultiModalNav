import { CACHE_HEADER, cachedResponse, openCache, storeCache } from '../../_lib/cache';
import { json, type Env } from '../../_lib/env';
import { callUpstream } from '../../_lib/upstream';
import { limitFor, recordUse, undoUse } from '../../_lib/usage';

// Traffic-aware car route via the TomTom Routing API. The API key never leaves the server.
// GET /api/traffic/route?from=lat,lon&to=lat,lon[&departAt=ISO|now]

// D1 cache lifetimes, in seconds.
const LIVE_TTL = 300;
const PREDICTED_TTL = 900;

const COORD = /^-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;

function validCoord(value: string | null): value is string {
  if (!value || !COORD.test(value)) return false;
  const [lat, lon] = value.split(',').map(Number);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function validTime(value: string | null): value is string {
  return value !== null && !Number.isNaN(Date.parse(value));
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  if (!env.TOMTOM_API_KEY) return json({ error: 'traffic_unconfigured' }, 503);

  const q = new URL(request.url).searchParams;
  const from = q.get('from');
  const to = q.get('to');
  if (!validCoord(from) || !validCoord(to)) return json({ error: 'from/to must be "lat,lon"' }, 400);
  const departAt = q.get('departAt') ?? 'now';
  if (departAt !== 'now' && !validTime(departAt)) return json({ error: 'bad departAt' }, 400);

  // Cache hits don't call TomTom, so they don't count toward the monthly limit.
  const cache = await openCache(env.USAGE_DB, 'tomtom', from, to, departAt);
  if (cache?.hit) return cachedResponse(cache.hit, { 'Cache-Control': 'no-store' });

  if (env.USAGE_DB) {
    // A broken tracker shouldn't break routing, so fail open.
    const allowed = await recordUse(env.USAGE_DB, 'tomtom.route', limitFor(env, 'tomtom.route')).catch(() => true);
    if (!allowed) return json({ error: 'monthly_limit_reached' }, 429);
  }

  const params = new URLSearchParams({
    key: env.TOMTOM_API_KEY,
    traffic: 'true',
    travelMode: 'car',
    routeType: 'fastest',
    computeTravelTimeFor: 'all',
    routeRepresentation: 'polyline',
  });
  params.set('departAt', departAt);

  const { response: upstream, rejected, via } = await callUpstream(
    env,
    request,
    {
      service: 'tomtom',
      url: `https://api.tomtom.com/routing/1/calculateRoute/${from}:${to}/json?${params}`,
      headers: { Accept: 'application/json' },
    },
    waitUntil,
  );
  if (rejected) {
    // The limiter turned it away, so TomTom was never called: don't count it.
    if (env.USAGE_DB) waitUntil(undoUse(env.USAGE_DB, 'tomtom.route').catch(() => {}));
    return upstream;
  }
  if (!upstream.ok) {
    // Don't pass TomTom's status through: the app reads 401 as "signed out" and 429 as our
    // monthly limit. 401/403 here usually means a wrong or disabled TomTom key.
    return json({ error: `TomTom returned HTTP ${upstream.status}`, upstreamStatus: upstream.status }, 502, {
      'X-Upstream-Via': via,
    });
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Upstream-Via': via };
  if (!cache) return new Response(upstream.body, { headers });
  const text = await upstream.text();
  // Live traffic goes stale within minutes; predictions for a later departure much less so.
  storeCache(cache, { body: text, contentType: 'application/json' }, departAt === 'now' ? LIVE_TTL : PREDICTED_TTL, waitUntil);
  return new Response(text, { headers: { ...headers, [CACHE_HEADER]: 'MISS' } });
};
