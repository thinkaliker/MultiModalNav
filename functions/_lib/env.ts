import type { RateEnv } from './ratelimit';

export { json } from './http';

export interface Env extends RateEnv {
  APP_PASSWORD?: string;
  TOMTOM_API_KEY?: string;
  /** Contact (email or URL) sent to Transitous in the User-Agent, as its usage policy asks. */
  TRANSITOUS_CONTACT?: string;
  /** The upstream request queue (gate/ Worker's Durable Object); optional. */
  GATE?: DurableObjectNamespace;
  TOMTOM_MAX_IN_FLIGHT?: string;
  TRANSITOUS_MAX_IN_FLIGHT?: string;
}
