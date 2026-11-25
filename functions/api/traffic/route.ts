import { json, type Env } from '../../_lib/env';
import { limitFor, recordUse } from '../../_lib/usage';

// Traffic-aware car route via the TomTom Routing API. The API key never leaves the server.
// GET /api/traffic/route?from=lat,lon&to=lat,lon[&departAt=ISO|now]

const COORD = /^-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;
const MAX_RETRIES = 2;

function validCoord(value: string | null): value is string {
  if (!value || !COORD.test(value)) return false;
  const [lat, lon] = value.split(',').map(Number);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function validTime(value: string | null): value is string {
  return value !== null && !Number.isNaN(Date.parse(value));
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.TOMTOM_API_KEY) return json({ error: 'traffic_unconfigured' }, 503);

  const q = new URL(request.url).searchParams;
  const from = q.get('from');
  const to = q.get('to');
  if (!validCoord(from) || !validCoord(to)) return json({ error: 'from/to must be "lat,lon"' }, 400);

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
  const departAt = q.get('departAt') ?? 'now';
  if (departAt !== 'now' && !validTime(departAt)) return json({ error: 'bad departAt' }, 400);
  params.set('departAt', departAt);

  const url = `https://api.tomtom.com/routing/1/calculateRoute/${from}:${to}/json?${params}`;
  let upstream = await fetch(url, { headers: { Accept: 'application/json' } });
  // TomTom's free tier caps requests per second; back off briefly and retry.
  for (let attempt = 1; upstream.status === 429 && attempt <= MAX_RETRIES; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    upstream = await fetch(url, { headers: { Accept: 'application/json' } });
  }
  if (!upstream.ok) {
    // Don't pass TomTom's status through: the app reads 401 as "signed out" and 429 as our
    // monthly limit. 401/403 here usually means a wrong or disabled TomTom key.
    return json({ error: `TomTom returned HTTP ${upstream.status}`, upstreamStatus: upstream.status }, 502);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
