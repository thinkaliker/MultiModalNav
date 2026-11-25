import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { limitFor, periodKey, readUsage, recordUse, type UsageDb, type UsageStatement } from '../functions/_lib/usage';

/** Minimal D1 stand-in over an in-memory SQLite database. */
function sqliteDb(): UsageDb {
  const db = new DatabaseSync(':memory:');
  const statement = (sql: string, args: unknown[] = []): UsageStatement & { all(): Promise<{ results: unknown[] }> } => ({
    bind: (...values) => statement(sql, values),
    run: async () => db.prepare(sql).run(...(args as never[])),
    first: async <T>() => (db.prepare(sql).get(...(args as never[])) as T | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async <T>(stmts: UsageStatement[]) =>
      Promise.all(stmts.map((s) => (s as ReturnType<typeof statement>).all())) as Promise<{ results: T[] }[]>,
  };
}

const now = new Date('2026-11-25T20:00:00Z');

describe('usage tracking', () => {
  it('uses UTC months and days', () => {
    expect(periodKey('month', now)).toBe('2026-11');
    expect(periodKey('day', now)).toBe('2026-11-25');
  });

  it('reads limits from the environment with defaults', () => {
    expect(limitFor({}, 'tomtom.route')).toBe(20000);
    expect(limitFor({ TOMTOM_MONTHLY_LIMIT: '500' }, 'tomtom.route')).toBe(500);
    expect(limitFor({ TOMTOM_MONTHLY_LIMIT: 'nope' }, 'tomtom.route')).toBe(20000);
    expect(limitFor({}, 'transitous.plan')).toBe(720);
  });

  it('counts uses per period and reports them', async () => {
    const db = sqliteDb();
    await recordUse(db, 'transitous.plan', undefined, now);
    await recordUse(db, 'transitous.plan', undefined, now);
    await recordUse(db, 'transitous.plan', undefined, new Date('2026-11-24T20:00:00Z')); // yesterday
    await recordUse(db, 'tomtom.route', 100, now);
    const usage = await readUsage(db, {}, now);
    expect(usage['transitous.plan']).toEqual({ used: 2, limit: 720, window: 'day', period: '2026-11-25' });
    expect(usage['tomtom.route']).toEqual({ used: 1, limit: 20000, window: 'month', period: '2026-11' });
  });

  it('stops counting and refuses once the limit is reached', async () => {
    const db = sqliteDb();
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await recordUse(db, 'tomtom.route', 3, now));
    expect(results).toEqual([true, true, true, false]);
    expect((await readUsage(db, {}, now))['tomtom.route'].used).toBe(3);
    // A new month starts fresh.
    expect(await recordUse(db, 'tomtom.route', 3, new Date('2026-12-01T00:00:00Z'))).toBe(true);
  });
});
