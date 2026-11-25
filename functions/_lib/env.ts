import type { RateEnv } from './ratelimit';

export interface Env extends RateEnv {
  APP_PASSWORD?: string;
  TOMTOM_API_KEY?: string;
  /** Contact (email or URL) sent to Transitous in the User-Agent, as its usage policy asks. */
  TRANSITOUS_CONTACT?: string;
}

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}
