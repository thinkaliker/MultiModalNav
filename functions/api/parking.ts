import { CACHE_HEADER, cacheKey, readCache, writeCache } from '../_lib/cache';
import { json } from '../_lib/http';
import { classifyParking, overpassQuery, type OverpassElement, type ParkingInfo, type Point } from '../_lib/parking';
import { callUpstream, type UpstreamEnv } from '../_lib/upstream';
import { userAgent } from '../_lib/useragent';

// Parking around transit stations, from OpenStreetMap through the Private.coffee Overpass API.
// POST /api/parking  {"stations":[{"lat":32.8669,"lon":-117.2304}, ...]}
//   -> {"parking":[ParkingInfo | null, ...], "incomplete"?: true}   (null: couldn't look it up)
// Following its terms (https://overpass.private.coffee/): POST requests, a User-Agent with the
// app's name and a contact, nothing personal in the query (only station positions), one query at
// a time across all clients (the 'overpass' service in upstream.ts), and a pause after it fails
// or is busy. Parking rarely changes, so each station's answer is kept for 30 days.

export const OVERPASS_URL = 'https://overpass.private.coffee/api/interpreter';
export const MAX_STATIONS = 24;
const TTL_SEC = 30 * 86_400;
const TIMEOUT_MS = 15_000;
/** How long to leave Overpass alone after it fails. */
export const COOLDOWN_SEC = 300;

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
export interface ParkingEnv extends UpstreamEnv {
  MULTIMODALNAV_CONTACT?: string;
}

interface Context {
  request: Request;
  env: ParkingEnv;
  waitUntil(promise: Promise<unknown>): void;
}

const stationKey = (p: Point) => cacheKey('parking:v1', String(p.lat), String(p.lon));
const cooldownKey = () => cacheKey('overpass:cooldown');

async function cached(env: ParkingEnv, key: Promise<string>): Promise<string | null> {
  if (!env.USAGE_DB) return null;
  try {
    return (await readCache(env.USAGE_DB, await key))?.body ?? null;
  } catch {
    return null;
  }
}

async function store(env: ParkingEnv, key: Promise<string>, body: string, contentType: string, ttlSec: number): Promise<void> {
  if (env.USAGE_DB) await writeCache(env.USAGE_DB, await key, { body, contentType }, ttlSec).catch(() => {});
}

/** One Overpass query for all `points`, classified; null if Overpass didn't answer in full. */
async function lookup(env: ParkingEnv, request: Request, points: Point[], waitUntil: (p: Promise<unknown>) => void) {
  if (await cached(env, cooldownKey())) return null;
  let elements: OverpassElement[] | null = null;
  let failed = true;
  try {
    const { response, rejected } = await callUpstream(
      env,
      request,
      {
        service: 'overpass',
        url: OVERPASS_URL,
        method: 'POST',
        headers: {
          'User-Agent': userAgent(env.MULTIMODALNAV_CONTACT),
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ data: overpassQuery(points) }).toString(),
        timeoutMs: TIMEOUT_MS,
      },
      waitUntil,
    );
    // Turned away by our own limiter: Overpass itself is fine.
    if (rejected) failed = false;
    if (response.ok && !rejected) {
      const body = (await response.json()) as { elements?: OverpassElement[]; remark?: string };
      // A query that ran out of time or memory still answers 200, with a remark and partial data.
      if (Array.isArray(body.elements) && !body.remark?.includes('error')) elements = body.elements;
    } else {
      await response.body?.cancel();
    }
  } catch (err) {
    console.warn('Overpass request failed:', (err as Error).message);
  }
  if (!elements) {
    if (failed) await store(env, cooldownKey(), '1', 'text/plain', COOLDOWN_SEC);
    return null;
  }
  const found = elements;
  const infos = points.map((p) => classifyParking(p, found));
  await Promise.all(infos.map((info, i) => store(env, stationKey(points[i]), JSON.stringify(info), 'application/json', TTL_SEC)));
  return infos;
}

export async function onRequestPost({ request, env, waitUntil }: Context): Promise<Response> {
  let stations: Point[] | null = null;
  try {
    stations = parseStations(await request.json());
  } catch {
    // reported below
  }
  if (!stations) return json({ error: `expected {"stations":[{"lat":…,"lon":…}]} with 1–${MAX_STATIONS} stations` }, 400);

  const parking = await Promise.all(
    stations.map(async (s) => {
      const body = await cached(env, stationKey(s));
      try {
        return body ? (JSON.parse(body) as ParkingInfo) : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  const missing = stations.filter((_, i) => !parking[i]);
  if (!missing.length) return json({ parking }, 200, { [CACHE_HEADER]: 'HIT' });

  // Keeps going if the app stops waiting, so the answer is cached for its next search.
  const pending = lookup(env, request, missing, waitUntil);
  waitUntil(pending);
  const found = await pending;
  let next = 0;
  const filled = parking.map((p) => p ?? found?.[next++] ?? null);
  return json(found ? { parking: filled } : { parking: filled, incomplete: true }, 200, { [CACHE_HEADER]: 'MISS' });
}
