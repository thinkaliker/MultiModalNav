import type { Env } from './env';
import { guardUpstream } from './ratelimit';
import { fetchWithRetry, GATE_HEADER, REJECTED_HEADER, type CacheOptions, type GateJob, type Service } from './upstream-common';

export interface UpstreamCall {
  service: Service;
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
  cf?: CacheOptions;
}

export interface UpstreamResult {
  response: Response;
  /** True when our own limiter answered instead of the upstream service. */
  rejected: boolean;
  /** Which limiter handled the call; sent back to the browser as X-Upstream-Via. */
  via: 'gate' | 'limiter';
}

const DEFAULT_IN_FLIGHT: Record<Service, number> = { tomtom: 2, transitous: 3 };
const QUEUE_MAX_WAIT_MS = 15_000;

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Make one upstream call, limited across all clients: through the gate's queue when the GATE
 * Durable Object is bound and reachable, otherwise through the D1 per-second limiter.
 */
export async function callUpstream(
  env: Env,
  request: Request,
  call: UpstreamCall,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<UpstreamResult> {
  const init = { method: call.method ?? 'GET', headers: call.headers, body: call.body, cf: call.cf };

  if (env.GATE) {
    const job: GateJob = {
      service: call.service,
      client: request.headers.get('CF-Connecting-IP') ?? 'local',
      url: call.url,
      method: init.method,
      headers: call.headers,
      body: call.body,
      cf: call.cf,
      limits: {
        inFlight: positive(
          call.service === 'tomtom' ? env.TOMTOM_MAX_IN_FLIGHT : env.TRANSITOUS_MAX_IN_FLIGHT,
          DEFAULT_IN_FLIGHT[call.service],
        ),
        clientPerMinute: positive(env.CLIENT_MAX_PER_MINUTE, 120),
        maxWaitMs: QUEUE_MAX_WAIT_MS,
      },
    };
    try {
      const gate = env.GATE.get(env.GATE.idFromName('global'));
      const response = await gate.fetch('https://gate/call', { method: 'POST', body: JSON.stringify(job) });
      if (response.headers.get(GATE_HEADER) === '1') {
        return { response, rejected: response.headers.get(REJECTED_HEADER) === '1', via: 'gate' };
      }
      // Not from the gate: the platform answered for it (gate not deployed or not running).
      await response.body?.cancel();
      console.warn(`GATE unavailable (HTTP ${response.status}), using the D1 limiter instead`);
    } catch (err) {
      // Gate unreachable: fall back to the D1 limiter below.
      console.warn('GATE unavailable, using the D1 limiter instead:', (err as Error).message);
    }
  }

  const limited = await guardUpstream(env, request, call.service, waitUntil);
  if (limited) return { response: limited, rejected: true, via: 'limiter' };
  return { response: await fetchWithRetry(call.url, init), rejected: false, via: 'limiter' };
}
