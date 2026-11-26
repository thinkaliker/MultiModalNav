import { CACHE_HEADER, cachedResponse, openCache, storeCache } from '../../_lib/cache';
import { json, type Env } from '../../_lib/env';
import { callUpstream } from '../../_lib/upstream';
import { fetchWithRetry, type CacheOptions } from '../../_lib/upstream-common';
import { recordUse } from '../../_lib/usage';
import { userAgent } from '../../_lib/useragent';

// Thin proxy to the Transitous (MOTIS 2) API. It exists to send a proper User-Agent as the
// Transitous usage policy asks, and to keep all upstream calls behind the password.
// Responses are streamed through untouched to keep Worker CPU time minimal, except those kept
// in the D1 cache.

const UPSTREAM = 'https://api.transitous.org/api/';
const MAX_BODY_BYTES = 64 * 1024;

// path -> methods allowed, edge and browser cache TTL (seconds, 0 = don't cache), D1 cache TTL
// (shared by all clients; plans keep it short because of real-time data), whether it counts
// toward Transitous's daily guideline (which covers /plan, /one-to-many and /one-to-all), and
// whether it goes through the shared rate limit. Station tiles skip it: they come in bursts on a
// new search and are mostly served from the edge cache.
const ROUTES: Record<string, { methods: string[]; ttl: number; dbTtl?: number; counted?: boolean; limited?: boolean }> = {
  'v6/plan': { methods: ['GET', 'POST'], ttl: 0, dbTtl: 120, counted: true, limited: true },
  'v6/stoptimes': { methods: ['GET'], ttl: 0, limited: true },
  'v6/trip': { methods: ['GET'], ttl: 0, limited: true },
  'v1/geocode': { methods: ['GET'], ttl: 3600, dbTtl: 86400, limited: true },
  'v1/reverse-geocode': { methods: ['GET'], ttl: 3600, dbTtl: 86400, limited: true },
  'v6/map/stops': { methods: ['GET'], ttl: 86400 },
  'experimental/map/routes': { methods: ['GET'], ttl: 86400 },
};

export const onRequest: PagesFunction<Env, 'path'> = async ({ request, params, env, waitUntil }) => {
  const segments = Array.isArray(params.path) ? params.path : [params.path];
  const path = segments.join('/');
  const route = ROUTES[path];
  if (!route) return json({ error: 'not found' }, 404);
  if (!route.methods.includes(request.method)) return json({ error: 'method not allowed' }, 405);

  const url = new URL(UPSTREAM + path);
  url.search = new URL(request.url).search;

  const headers: Record<string, string> = { 'User-Agent': userAgent(env.TRANSITOUS_CONTACT), Accept: 'application/json' };
  let body: string | undefined;
  let cf: CacheOptions | undefined;
  if (request.method === 'POST') {
    body = await request.text();
    if (body.length > MAX_BODY_BYTES) return json({ error: 'body too large' }, 413);
    headers['Content-Type'] = 'application/json';
  } else if (route.ttl > 0) {
    cf = { cacheTtl: route.ttl, cacheEverything: true };
  }

  const cacheControl = route.ttl > 0 ? `private, max-age=${route.ttl}` : 'no-store';
  const cache = route.dbTtl ? await openCache(env.USAGE_DB, request.method, path, url.search, body ?? '') : undefined;
  if (cache?.hit) return cachedResponse(cache.hit, { 'Cache-Control': cacheControl });

  let upstream: Response;
  let via = 'direct';
  if (route.limited) {
    const result = await callUpstream(
      env,
      request,
      { service: 'transitous', url: url.toString(), method: request.method, headers, body, cf },
      waitUntil,
    );
    if (result.rejected) return result.response;
    upstream = result.response;
    via = result.via;
  } else {
    upstream = await fetchWithRetry(url.toString(), { method: request.method, headers, body, cf });
  }
  if (route.counted && env.USAGE_DB) waitUntil(recordUse(env.USAGE_DB, 'transitous.plan').catch(() => {}));

  const contentType = upstream.headers.get('Content-Type') ?? 'application/json';
  const responseHeaders = new Headers({
    'Content-Type': contentType,
    'Cache-Control': upstream.ok ? cacheControl : 'no-store',
    'X-Upstream-Via': via,
  });
  if (cache && route.dbTtl && upstream.status === 200) {
    const text = await upstream.text();
    storeCache(cache, { body: text, contentType }, route.dbTtl, waitUntil);
    responseHeaders.set(CACHE_HEADER, 'MISS');
    return new Response(text, { headers: responseHeaders });
  }
  // 401 from upstream must not look like our own "signed out" response.
  return new Response(upstream.body, { status: upstream.status === 401 ? 502 : upstream.status, headers: responseHeaders });
};
