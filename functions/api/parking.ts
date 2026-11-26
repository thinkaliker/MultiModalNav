import { CACHE_HEADER, cacheKey, readCache, writeCache } from '../_lib/cache';
import { json } from '../_lib/http';
import { classifyParking, overpassQuery, type OverpassElement, type ParkingInfo, type Point } from '../_lib/parking';
import { failed, MIRRORS, type Health, type Mirror, type OverpassKeys } from '../_lib/overpass';
import { callUpstream, type UpstreamEnv } from '../_lib/upstream';
import { limitFor, recordUse, undoUse } from '../_lib/usage';
import { userAgent } from '../_lib/useragent';

// Parking around transit stations, from OpenStreetMap through public Overpass API servers
// (see overpass.ts for which, in what order).
// POST /api/parking  {"stations":[{"lat":32.8669,"lon":-117.2304}, ...]}
//   -> {"parking":[ParkingInfo | null, ...], "incomplete"?: true}   (null: couldn't look it up)
// Following the servers' terms: POST requests, a User-Agent naming the app, nothing personal in
// the query (only station positions), one query at a time per server across all clients, and a
// pause after a server fails. Parking rarely changes, so each station's answer is kept for 30 days.

export const MAX_STATIONS = 24;
const TTL_SEC = 30 * 86_400;
// Per server, then on to the next: an overloaded server can take far longer than this.
const MIRROR_TIMEOUT_MS = 6000;
const QUEUE_WAIT_MS = 3000;
// Don't start on another server after this long; the Worker may stop soon after 30 s.
const LOOKUP_BUDGET_MS = 15_000;
const HEALTH_TTL_SEC = 86_400;
/** Which server answered, for debugging. */
export const MIRROR_HEADER = 'X-Overpass-Mirror';

/** Valid station positions, rounded to about 10 m so nearby searches share cached answers. */
export function parseStations(body: unknown): Point[] | null {
  const list = (body as { stations?: unknown } | null)?.stations;
  if (!Array.isArray(list) || !list.length || list.length > MAX_STATIONS) return null;
  const out: Point[] = [];
  for (const s of list) {
    const { lat, lon } = (s ?? {}) as Record<string, unknown>;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) return null;
    out.push({ lat: Number(lat.toFixed(4)), lon: Number(lon.toFixed(4)) });
  }
  return out;
}

// Narrower than Env, so the tests can type-check this without the Workers types.
export interface ParkingEnv extends UpstreamEnv, OverpassKeys {
  MULTIMODALNAV_CONTACT?: string;
}

interface Context {
  request: Request;
  env: ParkingEnv;
  waitUntil(promise: Promise<unknown>): void;
}

const stationKey = (p: Point) => cacheKey('parking:v1', String(p.lat), String(p.lon));
const healthKey = (mirror: Mirror) => cacheKey('overpass:health', mirror.id);

async function cached(env: ParkingEnv, key: Promise<string>): Promise<string | null> {
  if (!env.USAGE_DB) return null;
  try {
    return (await readCache(env.USAGE_DB, await key))?.body ?? null;
  } catch {
    return null;
  }
}

function parsed<T>(body: string | null): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null;
  } catch {
    return null;
  }
}

async function store(env: ParkingEnv, key: Promise<string>, body: string, contentType: string, ttlSec: number): Promise<void> {
  if (env.USAGE_DB) await writeCache(env.USAGE_DB, await key, { body, contentType }, ttlSec).catch(() => {});
}

/** Ask one server; its elements, 'failed' (counts against it) or 'skipped' (our own limits). */
async function ask(
  env: ParkingEnv,
  request: Request,
  mirror: Mirror,
  url: string,
  points: Point[],
  waitUntil: (p: Promise<unknown>) => void,
): Promise<OverpassElement[] | 'failed' | 'skipped'> {
  if (mirror.dailyMetric && env.USAGE_DB) {
    const allowed = await recordUse(env.USAGE_DB, mirror.dailyMetric, limitFor(env, mirror.dailyMetric)).catch(() => true);
    if (!allowed) return 'skipped';
  }
  try {
    const { response, rejected } = await callUpstream(
      env,
      request,
      {
        service: `overpass:${mirror.id}`,
        url,
        method: 'POST',
        headers: {
          'User-Agent': userAgent(mirror.contact ? env.MULTIMODALNAV_CONTACT : undefined),
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ data: overpassQuery(points) }).toString(),
        timeoutMs: MIRROR_TIMEOUT_MS,
        maxWaitMs: QUEUE_WAIT_MS,
      },
      waitUntil,
    );
    if (rejected) {
      await response.body?.cancel();
      if (mirror.dailyMetric && env.USAGE_DB) await undoUse(env.USAGE_DB, mirror.dailyMetric).catch(() => {});
      return 'skipped';
    }
    if (!response.ok) {
      await response.body?.cancel();
      // Never log the URL: keyed servers have the key in it.
      if (response.status === 401 || response.status === 403) console.warn(`Overpass ${mirror.id}: key rejected (HTTP ${response.status})`);
      return 'failed';
    }
    const body = (await response.json()) as { elements?: OverpassElement[]; remark?: string };
    // A query that ran out of time or memory still answers 200, with a remark and partial data.
    return Array.isArray(body.elements) && !body.remark?.includes('error') ? body.elements : 'failed';
  } catch (err) {
    console.warn(`Overpass ${mirror.id} failed:`, (err as Error).message);
    return 'failed';
  }
}

/**
 * Parking for all `points` from the first server that answers, classified and cached; null if
 * none did. Servers that don't cover the stations, or are paused after failing, are skipped.
 */
async function lookup(env: ParkingEnv, request: Request, points: Point[], waitUntil: (p: Promise<unknown>) => void) {
  const started = Date.now();
  for (const mirror of MIRRORS) {
    if (Date.now() - started > LOOKUP_BUDGET_MS) break;
    const url = mirror.endpoint(points, env);
    if (!url) continue;
    const health = parsed<Health>(await cached(env, healthKey(mirror)));
    if (health && health.until > Date.now()) continue;

    const answer = await ask(env, request, mirror, url, points, waitUntil);
    if (answer === 'skipped') continue;
    if (answer === 'failed') {
      await store(env, healthKey(mirror), JSON.stringify(failed(health)), 'application/json', HEALTH_TTL_SEC);
      continue;
    }
    if (health?.failures) await store(env, healthKey(mirror), JSON.stringify({ failures: 0, until: 0 }), 'application/json', HEALTH_TTL_SEC);
    const infos = points.map((p) => classifyParking(p, answer));
    await Promise.all(infos.map((info, i) => store(env, stationKey(points[i]), JSON.stringify(info), 'application/json', TTL_SEC)));
    return { infos, mirror: mirror.id };
  }
  return null;
}

export async function onRequestPost({ request, env, waitUntil }: Context): Promise<Response> {
  let stations: Point[] | null = null;
  try {
    stations = parseStations(await request.json());
  } catch {
    // reported below
  }
  if (!stations) return json({ error: `expected {"stations":[{"lat":…,"lon":…}]} with 1–${MAX_STATIONS} stations` }, 400);

  const parking = await Promise.all(stations.map(async (s) => parsed<ParkingInfo>(await cached(env, stationKey(s)))));
  const missing = stations.filter((_, i) => !parking[i]);
  if (!missing.length) return json({ parking }, 200, { [CACHE_HEADER]: 'HIT' });

  // Keeps going if the app stops waiting, so the answer is cached for its next search.
  const pending = lookup(env, request, missing, waitUntil);
  waitUntil(pending);
  const found = await pending;
  let next = 0;
  const filled = parking.map((p) => p ?? found?.infos[next++] ?? null);
  return found
    ? json({ parking: filled }, 200, { [CACHE_HEADER]: 'MISS', [MIRROR_HEADER]: found.mirror })
    : json({ parking: filled, incomplete: true }, 200, { [CACHE_HEADER]: 'MISS' });
}
