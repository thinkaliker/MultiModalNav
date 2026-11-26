import { describe, expect, it } from 'vitest';
import { fetchWithRetry, GATE_HEADER, GateCore, REJECTED_HEADER, type GateJob, type UpstreamInit } from '../functions/_lib/upstream-common';

const job = (overrides: Partial<GateJob> = {}): GateJob => ({
  service: 'transitous',
  client: '198.51.100.1',
  url: 'https://upstream.test/plan',
  method: 'GET',
  headers: {},
  limits: { inFlight: 1, clientPerMinute: 100, maxWaitMs: 1000 },
  ...overrides,
});

/** A fetcher whose responses are released by hand, recording the order of calls. */
function manualFetcher() {
  const calls: string[] = [];
  const pending: (() => void)[] = [];
  const fetcher = (url: string, _init: UpstreamInit) => {
    calls.push(url);
    return new Promise<Response>((resolve) => pending.push(() => resolve(new Response(`{"url":"${url}"}`))));
  };
  return { fetcher, calls, finishNext: () => pending.shift()?.() };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('GateCore', () => {
  it('runs requests first come, first served, within the in-flight limit', async () => {
    const upstream = manualFetcher();
    const gate = new GateCore(upstream.fetcher);
    const results = ['a', 'b', 'c'].map((name) => gate.handle(job({ url: `https://upstream.test/${name}` })));
    await tick();
    expect(upstream.calls).toEqual(['https://upstream.test/a']);
    expect(gate.load('transitous')).toEqual({ active: 1, waiting: 2 });

    upstream.finishNext();
    await tick();
    expect(upstream.calls).toEqual(['https://upstream.test/a', 'https://upstream.test/b']);
    upstream.finishNext();
    await tick();
    upstream.finishNext();
    const bodies = await Promise.all(results.map(async (r) => (await r).json()));
    expect(bodies.map((b) => (b as { url: string }).url)).toEqual([
      'https://upstream.test/a',
      'https://upstream.test/b',
      'https://upstream.test/c',
    ]);
    expect(gate.load('transitous')).toEqual({ active: 0, waiting: 0 });
  });

  it('keeps separate queues per service', async () => {
    const upstream = manualFetcher();
    const gate = new GateCore(upstream.fetcher);
    void gate.handle(job({ service: 'transitous', url: 'https://upstream.test/t' }));
    void gate.handle(job({ service: 'tomtom', url: 'https://upstream.test/r' }));
    await tick();
    expect(upstream.calls).toEqual(['https://upstream.test/t', 'https://upstream.test/r']);
  });

  it('answers "busy" when a request waits too long', async () => {
    const upstream = manualFetcher();
    const gate = new GateCore(upstream.fetcher);
    void gate.handle(job());
    const waiting = await gate.handle(job({ limits: { inFlight: 1, clientPerMinute: 100, maxWaitMs: 20 } }));
    expect(waiting.status).toBe(503);
    expect(waiting.headers.get(REJECTED_HEADER)).toBe('1');
    expect(gate.load('transitous')).toEqual({ active: 1, waiting: 0 });
  });

  it('caps requests per device per minute', async () => {
    const gate = new GateCore(async () => new Response('{}'), () => Date.parse('2026-11-26T10:00:15Z'));
    const limits = { inFlight: 5, clientPerMinute: 2, maxWaitMs: 1000 };
    expect((await gate.handle(job({ limits }))).status).toBe(200);
    expect((await gate.handle(job({ limits }))).status).toBe(200);
    const blocked = await gate.handle(job({ limits }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('45');
    expect(blocked.headers.get(REJECTED_HEADER)).toBe('1');
    expect((await gate.handle(job({ limits, client: '198.51.100.2' }))).status).toBe(200);
  });

  it('frees the slot when the upstream request fails', async () => {
    let calls = 0;
    const gate = new GateCore(async () => {
      calls++;
      if (calls === 1) throw new Error('network down');
      return new Response('{}');
    });
    const failed = await gate.handle(job());
    expect(failed.status).toBe(502);
    expect(failed.headers.get(REJECTED_HEADER)).toBeNull();
    expect((await gate.handle(job())).status).toBe(200);
  });

  it('marks every answer as coming from the gate', async () => {
    const gate = new GateCore(async () => new Response('{}'));
    const limits = { inFlight: 1, clientPerMinute: 1, maxWaitMs: 1000 };
    const answered = await gate.handle(job({ limits }));
    const refused = await gate.handle(job({ limits }));
    expect([answered.status, refused.status]).toEqual([200, 429]);
    expect([answered.headers.get(GATE_HEADER), refused.headers.get(GATE_HEADER)]).toEqual(['1', '1']);
  });
});

describe('GateCore timeouts', () => {
  it('passes a job\'s timeout on to the upstream fetch', async () => {
    const seen: UpstreamInit[] = [];
    const gate = new GateCore(async (_url, init) => {
      seen.push(init);
      return new Response('{}');
    });
    await gate.handle(job({ service: 'overpass:private.coffee', timeoutMs: 20_000 }));
    expect(seen[0].timeoutMs).toBe(20_000);
  });
});

describe('fetchWithRetry', () => {
  it('retries "too many requests" and returns the eventual answer', async () => {
    const statuses = [429, 200];
    const res = await fetchWithRetry('https://upstream.test', {}, async () => new Response('{}', { status: statuses.shift() }));
    expect(res.status).toBe(200);
  });

  it("doesn't retry Overpass servers, which count every query", async () => {
    let calls = 0;
    const gate = new GateCore(async () => {
      calls++;
      return new Response('{}', { status: 429 });
    });
    expect((await gate.handle(job({ service: 'overpass:fairwaymapper' }))).status).toBe(429);
    expect(calls).toBe(1);
  });
});
