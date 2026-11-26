import type { RateEnv } from './ratelimit';

export { json } from './http';

export interface Env extends RateEnv {
  APP_PASSWORD?: string;
  TOMTOM_API_KEY?: string;
  /**
   * Contact (email or URL) sent in the User-Agent to Transitous and the Private.coffee Overpass
   * API, as their usage policies ask.
   */
  MULTIMODALNAV_CONTACT?: string;
  /** NextGIS Overpass API key (or its full interpreter URL), for parking data; optional. */
  NEXTGIS_OVERPASS_KEY?: string;
  /** FairwayMapper Overpass API key (or its full interpreter URL), for parking data; optional. */
  FAIRWAYMAPPER_OVERPASS_KEY?: string;
  /** The upstream request queue (gate/ Worker's Durable Object); optional. */
  GATE?: DurableObjectNamespace;
  TOMTOM_MAX_IN_FLIGHT?: string;
  TRANSITOUS_MAX_IN_FLIGHT?: string;
}
