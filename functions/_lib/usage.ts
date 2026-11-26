// Usage counters for the upstream services with free-tier limits, kept in D1 (optional:
// without a USAGE_DB binding nothing is counted and nothing is limited).

export type Metric = 'tomtom.route' | 'transitous.plan' | 'overpass-api.de';

interface MetricInfo {
  /** TomTom's free tier is monthly; Transitous asks for a heads-up above ~720 plan queries a day. */
  window: 'month' | 'day';
  defaultLimit: number;
  limitVar: 'TOMTOM_MONTHLY_LIMIT' | 'TRANSITOUS_DAILY_LIMIT' | 'OVERPASS_DE_DAILY_LIMIT';
}

export const METRICS: Record<Metric, MetricInfo> = {
  'tomtom.route': { window: 'month', defaultLimit: 20_000, limitVar: 'TOMTOM_MONTHLY_LIMIT' },
  'transitous.plan': { window: 'day', defaultLimit: 720, limitVar: 'TRANSITOUS_DAILY_LIMIT' },
  // The main Overpass server's guideline for regular use is under 100 queries a day, all users together.
  'overpass-api.de': { window: 'day', defaultLimit: 50, limitVar: 'OVERPASS_DE_DAILY_LIMIT' },
};

/** The parts of a D1 database used here; structural so tests can use plain SQLite. */
export interface UsageStatement {
  bind(...values: unknown[]): UsageStatement;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface UsageDb {
  prepare(query: string): UsageStatement;
  batch<T = unknown>(statements: UsageStatement[]): Promise<{ results: T[] }[]>;
}

export interface UsageEnv {
  USAGE_DB?: UsageDb;
  TOMTOM_MONTHLY_LIMIT?: string;
  TRANSITOUS_DAILY_LIMIT?: string;
  OVERPASS_DE_DAILY_LIMIT?: string;
}

export interface Meter {
  used: number;
  limit: number;
  window: 'month' | 'day';
  period: string;
}

/** UTC calendar month ("2026-11") or day ("2026-11-25"). */
export function periodKey(window: 'month' | 'day', now = new Date()): string {
  return now.toISOString().slice(0, window === 'month' ? 7 : 10);
}

export function limitFor(env: UsageEnv, metric: Metric): number {
  const info = METRICS[metric];
  const value = Number(env[info.limitVar]);
  return Number.isFinite(value) && value > 0 ? value : info.defaultLimit;
}

const schemas = new WeakMap<UsageDb, Promise<unknown>>();

/** Create the tables on first use, once per database. */
export function ensureSchema(db: UsageDb): Promise<unknown> {
  let ready = schemas.get(db);
  if (!ready) {
    ready = db
      .batch([
        db.prepare(
          'CREATE TABLE IF NOT EXISTS usage (period TEXT NOT NULL, metric TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (period, metric))',
        ),
        // Rate-limit windows (see ratelimit.ts); old rows are pruned as they expire.
        db.prepare(
          'CREATE TABLE IF NOT EXISTS rate (key TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (key, window_start))',
        ),
        // Cached upstream responses (see cache.ts); expired rows are pruned now and then.
        db.prepare(
          'CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, expires INTEGER NOT NULL, content_type TEXT NOT NULL, body TEXT NOT NULL)',
        ),
        db.prepare('CREATE INDEX IF NOT EXISTS cache_expires ON cache (expires)'),
      ])
      .catch((err) => {
        schemas.delete(db);
        throw err;
      });
    schemas.set(db, ready);
  }
  return ready;
}

/**
 * Count one use. With a `limit`, the check and the increment happen in one statement, and
 * nothing is counted (returns false) once the limit has been reached.
 */
export async function recordUse(db: UsageDb, metric: Metric, limit?: number, now = new Date()): Promise<boolean> {
  await ensureSchema(db);
  const period = periodKey(METRICS[metric].window, now);
  if (limit === undefined) {
    await db
      .prepare(
        'INSERT INTO usage (period, metric, count) VALUES (?1, ?2, 1) ON CONFLICT (period, metric) DO UPDATE SET count = count + 1',
      )
      .bind(period, metric)
      .run();
    return true;
  }
  const row = await db
    .prepare(
      'INSERT INTO usage (period, metric, count) VALUES (?1, ?2, 1) ON CONFLICT (period, metric) DO UPDATE SET count = count + 1 WHERE count < ?3 RETURNING count',
    )
    .bind(period, metric, limit)
    .first();
  return row !== null;
}

/** Take back one use that turned out not to happen (e.g. the request was rate-limited). */
export async function undoUse(db: UsageDb, metric: Metric, now = new Date()): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare('UPDATE usage SET count = count - 1 WHERE period = ?1 AND metric = ?2 AND count > 0')
    .bind(periodKey(METRICS[metric].window, now), metric)
    .run();
}

export async function readUsage(db: UsageDb, env: UsageEnv, now = new Date()): Promise<Record<Metric, Meter>> {
  await ensureSchema(db);
  const metrics = Object.keys(METRICS) as Metric[];
  const periods = metrics.map((m) => periodKey(METRICS[m].window, now));
  const results = await db.batch<{ count: number }>(
    metrics.map((m, i) => db.prepare('SELECT count FROM usage WHERE period = ?1 AND metric = ?2').bind(periods[i], m)),
  );
  return Object.fromEntries(
    metrics.map((m, i) => [
      m,
      { used: results[i].results[0]?.count ?? 0, limit: limitFor(env, m), window: METRICS[m].window, period: periods[i] },
    ]),
  ) as Record<Metric, Meter>;
}
