import { DatabaseSync } from 'node:sqlite';
import type { UsageDb, UsageStatement } from '../functions/_lib/usage';

/** Minimal D1 stand-in over an in-memory SQLite database. */
export function sqliteDb(): UsageDb {
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
