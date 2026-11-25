import { json, type Env } from '../../_lib/env';
import { recordUse } from '../../_lib/usage';
import { userAgent } from '../../_lib/useragent';

// Thin proxy to the Transitous (MOTIS 2) API. It exists to send a proper User-Agent as the
// Transitous usage policy asks, and to keep all upstream calls behind the password.
// Responses are streamed through untouched to keep Worker CPU time minimal.

const UPSTREAM = 'https://api.transitous.org/api/';
const MAX_BODY_BYTES = 64 * 1024;

// path -> methods allowed, edge cache TTL (seconds, 0 = don't cache), and whether it counts
// toward Transitous's daily guideline (which covers /plan, /one-to-many and /one-to-all).
const ROUTES: Record<string, { methods: string[]; ttl: number; counted?: boolean }> = {
  'v6/plan': { methods: ['GET', 'POST'], ttl: 0, counted: true },
  'v6/stoptimes': { methods: ['GET'], ttl: 0 },
  'v6/trip': { methods: ['GET'], ttl: 0 },
  'v1/geocode': { methods: ['GET'], ttl: 3600 },
  'v1/reverse-geocode': { methods: ['GET'], ttl: 3600 },
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

  const init: RequestInit<RequestInitCfProperties> = {
    method: request.method,
    headers: { 'User-Agent': userAgent(env.TRANSITOUS_CONTACT), Accept: 'application/json' },
  };
  if (request.method === 'POST') {
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return json({ error: 'body too large' }, 413);
    init.body = body;
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  } else if (route.ttl > 0) {
    init.cf = { cacheTtl: route.ttl, cacheEverything: true };
  }

  if (route.counted && env.USAGE_DB) waitUntil(recordUse(env.USAGE_DB, 'transitous.plan').catch(() => {}));

  const upstream = await fetch(url.toString(), init);
  const headers = new Headers({
    'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
    'Cache-Control': route.ttl > 0 && upstream.ok ? `private, max-age=${route.ttl}` : 'no-store',
  });
  // 401 from upstream must not look like our own "signed out" response.
  return new Response(upstream.body, { status: upstream.status === 401 ? 502 : upstream.status, headers });
};
