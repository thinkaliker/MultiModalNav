// Rate limits shared by every client, kept in the USAGE_DB D1 database (D1 is strongly
// consistent, so all requests see the same counts). Without the database nothing is limited
// here; each browser tab still limits its own concurrency.

import { json } from './env';
import { ensureSchema, type UsageDb, type UsageEnv } from './usage';

export interface RateEnv extends UsageEnv {
  TOMTOM_MAX_PER_SECOND?: string;
  TRANSITOUS_MAX_PER_SECOND?: string;
  CLIENT_MAX_PER_MINUTE?: string;
}

export type Service = 'tomtom' | 'transitous';

const DEFAULTS = { tomtom: 4, transitous: 4, clientPerMinute: 120 };
const MAX_WAIT_MS = 8000;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Take one unit from the fixed window containing `now`; false if that window is already full. */
export async function take(db: UsageDb, key: string, windowMs: number, limit: number, now: number): Promise<boolean> {
  await ensureSchema(db);
  const start = Math.floor(now / windowMs) * windowMs;
  const row = await db
    .prepare(
      'INSERT INTO rate (key, window_start, count) VALUES (?1, ?2, 1) ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 WHERE count < ?3 RETURNING count',
    )
    .bind(key, start, limit)
    .first();
  return row !== null;
}

/** Wait for a slot in a per-second budget; false if none frees up within `maxWaitMs`. */
export async function waitForSlot(
  db: UsageDb,
  key: string,
  perSecond: number,
  maxWaitMs = MAX_WAIT_MS,
  clock: Clock = realClock,
): Promise<boolean> {
  const deadline = clock.now() + maxWaitMs;
  for (;;) {
    const now = clock.now();
    if (await take(db, key, 1000, perSecond, now)) return true;
    const nextWindow = Math.floor(now / 1000) * 1000 + 1000;
    if (nextWindow > deadline) return false;
    // A little jitter so waiting requests don't all retry at the same instant.
    await clock.sleep(nextWindow - now + Math.floor(Math.random() * 50));
  }
}

export function pruneWindows(db: UsageDb, now: number): Promise<unknown> {
  return db.prepare('DELETE FROM rate WHERE window_start < ?1').bind(now - 120_000).run();
}

/**
 * Guard one upstream call: a per-client cap per minute, then the upstream service's shared
 * per-second budget (waiting briefly for a slot). Returns a response to send instead of calling
 * upstream, or null to go ahead.
 */
export async function guardUpstream(
  env: RateEnv,
  request: Request,
  service: Service,
  waitUntil: (promise: Promise<unknown>) => void,
  clock: Clock = realClock,
): Promise<Response | null> {
  const db = env.USAGE_DB;
  if (!db) return null;
  try {
    const now = clock.now();
    if (Math.random() < 0.02) waitUntil(pruneWindows(db, now).catch(() => {}));

    const client = request.headers.get('CF-Connecting-IP') ?? 'local';
    const perMinute = positive(env.CLIENT_MAX_PER_MINUTE, DEFAULTS.clientPerMinute);
    if (!(await take(db, `client:${client}`, 60_000, perMinute, now))) {
      const retryAfter = Math.ceil((60_000 - (now % 60_000)) / 1000);
      return json({ error: `Too many requests from this device; try again in ${retryAfter} s` }, 429, {
        'Retry-After': String(retryAfter),
      });
    }

    const perSecond = positive(
      service === 'tomtom' ? env.TOMTOM_MAX_PER_SECOND : env.TRANSITOUS_MAX_PER_SECOND,
      DEFAULTS[service],
    );
    if (!(await waitForSlot(db, `service:${service}`, perSecond, MAX_WAIT_MS, clock))) {
      return json({ error: 'Server busy; try again shortly' }, 503, { 'Retry-After': '2' });
    }
    return null;
  } catch {
    return null; // A broken limiter shouldn't take routing down.
  }
}
