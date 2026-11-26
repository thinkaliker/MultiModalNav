import { describe, expect, it } from 'vitest';
import { cacheKey, openCache, pruneCache, readCache, writeCache } from '../functions/_lib/cache';
import { sqliteDb } from './sqlite';

const answer = { body: '{"itineraries":[]}', contentType: 'application/json' };

describe('cacheKey', () => {
  it('is stable and depends on every part', async () => {
    const key = await cacheKey('GET', 'v6/plan', '?a=1', '');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await cacheKey('GET', 'v6/plan', '?a=1', '')).toBe(key);
    expect(await cacheKey('POST', 'v6/plan', '?a=1', '{}')).not.toBe(key);
  });
});

describe('D1 cache', () => {
  it('serves an answer until it expires', async () => {
    const db = sqliteDb();
    await writeCache(db, 'k', answer, 60, 1_000_000);
    expect(await readCache(db, 'k', 1_000_000 + 59_000)).toEqual(answer);
    expect(await readCache(db, 'k', 1_000_000 + 60_000)).toBeNull();
    expect(await readCache(db, 'other', 1_000_000)).toBeNull();
  });

  it('replaces an older answer for the same key', async () => {
    const db = sqliteDb();
    await writeCache(db, 'k', answer, 60, 0);
    await writeCache(db, 'k', { ...answer, body: '{"new":true}' }, 60, 120_000);
    expect((await readCache(db, 'k', 150_000))?.body).toBe('{"new":true}');
  });

  it('skips answers too big for a D1 row', async () => {
    const db = sqliteDb();
    await writeCache(db, 'big', { ...answer, body: 'x'.repeat(600_000) }, 60, 0);
    expect(await readCache(db, 'big', 0)).toBeNull();
  });

  it('prunes expired rows', async () => {
    const db = sqliteDb();
    await writeCache(db, 'old', answer, 10, 0);
    await writeCache(db, 'new', answer, 100, 0);
    await pruneCache(db, 50_000);
    const left = await db.prepare('SELECT key FROM cache').first<{ key: string }>();
    expect(left?.key).toBe('new');
  });

  it('is skipped without a database', async () => {
    expect(await openCache(undefined, 'x')).toBeUndefined();
    const slot = await openCache(sqliteDb(), 'x');
    expect(slot?.hit).toBeNull();
  });
});
