import { describe, expect, it } from 'vitest';
import { guardUpstream, take, waitForSlot, type Clock } from '../functions/_lib/ratelimit';
import { sqliteDb } from './sqlite';

/** A clock whose sleep just moves time forward. */
function fakeClock(start: number): Clock & { slept: number[] } {
  let now = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  };
}

const T0 = Date.parse('2026-11-25T20:00:00.000Z');
const request = (ip = '203.0.113.7') => new Request('https://example.test/api', { headers: { 'CF-Connecting-IP': ip } });
const noop = () => {};

describe('take', () => {
  it('allows up to the limit per window, then starts fresh in the next one', async () => {
    const db = sqliteDb();
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await take(db, 'k', 1000, 3, T0 + 100));
    expect(results).toEqual([true, true, true, false]);
    expect(await take(db, 'other', 1000, 3, T0 + 100)).toBe(true);
    expect(await take(db, 'k', 1000, 3, T0 + 1000)).toBe(true);
  });
});

describe('waitForSlot', () => {
  it('waits for the next second when the budget is used up', async () => {
    const db = sqliteDb();
    const clock = fakeClock(T0 + 200);
    expect(await waitForSlot(db, 's', 2, 8000, clock)).toBe(true);
    expect(await waitForSlot(db, 's', 2, 8000, clock)).toBe(true);
    expect(clock.slept).toEqual([]);
    expect(await waitForSlot(db, 's', 2, 8000, clock)).toBe(true);
    expect(clock.slept).toHaveLength(1);
    expect(clock.now()).toBeGreaterThanOrEqual(T0 + 1000);
  });

  it('gives up when no slot frees up in time', async () => {
    const db = sqliteDb();
    const clock = fakeClock(T0 + 200);
    expect(await waitForSlot(db, 's', 1, 8000, clock)).toBe(true);
    expect(await waitForSlot(db, 's', 1, 500, clock)).toBe(false);
  });
});

describe('guardUpstream', () => {
  it('does nothing without a database', async () => {
    expect(await guardUpstream({}, request(), 'tomtom', noop)).toBeNull();
  });

  it('caps each device per minute, independently of others', async () => {
    const env = { USAGE_DB: sqliteDb(), CLIENT_MAX_PER_MINUTE: '2', TOMTOM_MAX_PER_SECOND: '100' };
    const clock = fakeClock(T0 + 15_000);
    expect(await guardUpstream(env, request(), 'tomtom', noop, clock)).toBeNull();
    expect(await guardUpstream(env, request(), 'tomtom', noop, clock)).toBeNull();
    const blocked = await guardUpstream(env, request(), 'tomtom', noop, clock);
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get('Retry-After')).toBe('45');
    expect(await blocked?.json()).toEqual({ error: 'Too many requests from this device; try again in 45 s' });
    expect(await guardUpstream(env, request('198.51.100.1'), 'tomtom', noop, clock)).toBeNull();
  });

  it('shares the per-second budget across devices', async () => {
    const env = { USAGE_DB: sqliteDb(), TRANSITOUS_MAX_PER_SECOND: '1' };
    const clock = fakeClock(T0 + 100);
    expect(await guardUpstream(env, request('198.51.100.1'), 'transitous', noop, clock)).toBeNull();
    // A second device has to wait for the next second.
    expect(await guardUpstream(env, request('198.51.100.2'), 'transitous', noop, clock)).toBeNull();
    expect(clock.now()).toBeGreaterThanOrEqual(T0 + 1000);
    // TomTom has its own budget.
    expect(await guardUpstream(env, request('198.51.100.3'), 'tomtom', noop, clock)).toBeNull();
  });
});
