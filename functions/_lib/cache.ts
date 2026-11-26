// Successful upstream answers kept in the USAGE_DB D1 database for a while, so repeat searches
// (from any client) don't spend free-tier quota. Without the database nothing is cached, and a
// broken cache only means no caching.

import { ensureSchema, type UsageDb } from './usage';

/** Tells the app whether the cache answered ("HIT") or the upstream service did ("MISS"). */
export const CACHE_HEADER = 'X-Cache';

// D1 rows top out at 2 MB; answers bigger than this are rare and simply aren't cached.
const MAX_BODY_CHARS = 500_000;

export interface CachedResponse {
  body: string;
  contentType: string;
}

export interface CacheSlot {
  db: UsageDb;
  key: string;
  hit: CachedResponse | null;
}

/** A fixed-length key for a request, from the parts that make its answer unique. */
export async function cacheKey(...parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('\n')));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function readCache(db: UsageDb, key: string, now = Date.now()): Promise<CachedResponse | null> {
  await ensureSchema(db);
  const row = await db
    .prepare('SELECT body, content_type FROM cache WHERE key = ?1 AND expires > ?2')
    .bind(key, now)
    .first<{ body: string; content_type: string }>();
  return row && { body: row.body, contentType: row.content_type };
}

export async function writeCache(
  db: UsageDb,
  key: string,
  value: CachedResponse,
  ttlSec: number,
  now = Date.now(),
): Promise<void> {
  if (value.body.length > MAX_BODY_CHARS) return;
  await ensureSchema(db);
  await db
    .prepare(
      'INSERT INTO cache (key, expires, content_type, body) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (key) DO UPDATE SET expires = excluded.expires, content_type = excluded.content_type, body = excluded.body',
    )
    .bind(key, now + ttlSec * 1000, value.contentType, value.body)
    .run();
}

export function pruneCache(db: UsageDb, now = Date.now()): Promise<unknown> {
  return db.prepare('DELETE FROM cache WHERE expires <= ?1').bind(now).run();
}

/** Look a request up; undefined when there's no database or it can't be read. */
export async function openCache(db: UsageDb | undefined, ...parts: string[]): Promise<CacheSlot | undefined> {
  if (!db) return undefined;
  try {
    const key = await cacheKey(...parts);
    return { db, key, hit: await readCache(db, key) };
  } catch {
    return undefined;
  }
}

export function cachedResponse(hit: CachedResponse, headers: Record<string, string> = {}): Response {
  return new Response(hit.body, { headers: { 'Content-Type': hit.contentType, [CACHE_HEADER]: 'HIT', ...headers } });
}

/** Store an answer (in the background via `waitUntil`), pruning expired rows now and then. */
export function storeCache(
  slot: CacheSlot,
  value: CachedResponse,
  ttlSec: number,
  waitUntil: (promise: Promise<unknown>) => void,
): void {
  waitUntil(writeCache(slot.db, slot.key, value, ttlSec).catch(() => {}));
  if (Math.random() < 0.02) waitUntil(pruneCache(slot.db).catch(() => {}));
}
