// Shared by the Pages Functions and the gate Worker (gate/), so it only uses web-standard APIs.

import { json } from './http';

export type Service = 'tomtom' | 'transitous';

/** Edge-cache options for a request (the subset of Cloudflare's `cf` options used here). */
export interface CacheOptions {
  cacheTtl?: number;
  cacheEverything?: boolean;
}

export interface UpstreamInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  cf?: CacheOptions;
}

export type Fetcher = (url: string, init: UpstreamInit) => Promise<Response>;

// Cloudflare's fetch accepts `cf` cache options; the cast bridges the DOM and Workers typings.
const platformFetch: Fetcher = (url, init) => fetch(url, init as unknown as RequestInit);

/** One upstream request handed to the gate. */
export interface GateJob {
  service: Service;
  /** Who's asking (IP address), for the per-device cap. */
  client: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  cf?: CacheOptions;
  limits: {
    /** Requests to this service in flight at once, across all clients. */
    inFlight: number;
    clientPerMinute: number;
    /** How long a request may wait in the queue before giving up. */
    maxWaitMs: number;
  };
}

/** Marks a response that came from the gate or limiter itself rather than from upstream. */
export const REJECTED_HEADER = 'X-Limiter-Rejected';

export function rejected(status: 429 | 503, error: string, retryAfterSec: number): Response {
  return json({ error }, status, { 'Retry-After': String(retryAfterSec), [REJECTED_HEADER]: '1' });
}

const MAX_RETRIES = 2;

/** Fetch, backing off and retrying when upstream answers "too many requests". */
export async function fetchWithRetry(url: string, init: UpstreamInit, fetcher: Fetcher = platformFetch): Promise<Response> {
  let res = await fetcher(url, init);
  for (let attempt = 1; res.status === 429 && attempt <= MAX_RETRIES; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    res = await fetcher(url, init);
  }
  return res;
}

/**
 * The queue behind the gate: a per-device cap per minute, then a first-come-first-served
 * queue per service that lets `limits.inFlight` requests run at once. In-memory, so it relies
 * on running in a single Durable Object instance.
 */
export class GateCore {
  private active = new Map<Service, number>();
  private queues = new Map<Service, (() => void)[]>();
  private clients = new Map<string, { minute: number; count: number }>();

  constructor(
    private fetcher: Fetcher = platformFetch,
    private now: () => number = Date.now,
  ) {}

  async handle(job: GateJob): Promise<Response> {
    const now = this.now();
    const minute = Math.floor(now / 60_000);
    const seen = this.clients.get(job.client);
    const count = seen?.minute === minute ? seen.count : 0;
    if (count >= job.limits.clientPerMinute) {
      const retryAfter = Math.ceil((60_000 - (now % 60_000)) / 1000);
      return rejected(429, `Too many requests from this device; try again in ${retryAfter} s`, retryAfter);
    }
    this.clients.set(job.client, { minute, count: count + 1 });
    if (this.clients.size > 1000) {
      for (const [client, entry] of this.clients) if (entry.minute < minute) this.clients.delete(client);
    }

    if (!(await this.acquire(job.service, job.limits.inFlight, job.limits.maxWaitMs))) {
      return rejected(503, 'Server busy; try again shortly', 2);
    }
    try {
      const res = await fetchWithRetry(
        job.url,
        { method: job.method, headers: job.headers, body: job.body, cf: job.cf },
        this.fetcher,
      );
      // The slot is freed once headers arrive; the body streams on without holding it.
      return new Response(res.body, {
        status: res.status,
        headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
      });
    } catch (err) {
      return json({ error: `Upstream request failed: ${(err as Error).message}` }, 502);
    } finally {
      this.release(job.service);
    }
  }

  /** Requests currently running or waiting, per service (for tests and debugging). */
  load(service: Service): { active: number; waiting: number } {
    return { active: this.active.get(service) ?? 0, waiting: this.queues.get(service)?.length ?? 0 };
  }

  private acquire(service: Service, limit: number, maxWaitMs: number): Promise<boolean> {
    const active = this.active.get(service) ?? 0;
    if (active < limit) {
      this.active.set(service, active + 1);
      return Promise.resolve(true);
    }
    let queue = this.queues.get(service);
    if (!queue) this.queues.set(service, (queue = []));
    const waiting = queue;
    return new Promise((resolve) => {
      const grant = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const i = waiting.indexOf(grant);
        if (i >= 0) waiting.splice(i, 1);
        resolve(false);
      }, maxWaitMs);
      waiting.push(grant);
    });
  }

  /** Hand the slot straight to the next waiting request, or free it. */
  private release(service: Service): void {
    const next = this.queues.get(service)?.shift();
    if (next) next();
    else this.active.set(service, Math.max(0, (this.active.get(service) ?? 1) - 1));
  }
}
