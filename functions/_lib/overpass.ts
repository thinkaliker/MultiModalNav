// The public Overpass API servers used for parking data, tried in order. Each has its own
// one-at-a-time queue, and one that fails is skipped for a while (longer each time it fails
// again), so a struggling server is left alone and the next one answers instead.

import type { Point } from './parking';
import type { Metric } from './usage';

export interface Mirror {
  /** Short name, also used for its queue ("overpass:<id>") and health record. */
  id: string;
  /** The interpreter URL for a query around `points`, or null if the server doesn't cover them all. */
  endpoint(points: Point[]): string | null;
  /** Whether it gets MULTIMODALNAV_CONTACT in the User-Agent; the others get the app name and repo. */
  contact: boolean;
  /** A daily cap across all users, for servers whose usage policy sets one. */
  dailyMetric?: Metric;
}

type Box = [south: number, west: number, north: number, east: number];

const within = (points: Point[], [south, west, north, east]: Box) =>
  points.every((p) => p.lat >= south && p.lat <= north && p.lon >= west && p.lon <= east);

// dresel.systems serves one Geofabrik continent extract per endpoint. These boxes stay well
// inside the North America (US, Canada) and Europe extracts.
const DRESEL_REGIONS: [path: string, box: Box][] = [
  ['api-na', [24, -170, 72, -52]],
  ['api', [36, -11, 71, 30]],
];

const fixed = (url: string) => () => url;

export const MIRRORS: Mirror[] = [
  // Free with no rate limit; the owner chose it, so it alone gets their contact.
  { id: 'private.coffee', endpoint: fixed('https://overpass.private.coffee/api/interpreter'), contact: true },
  // Free, no key, up to 4 parallel queries per IP; data refreshed nightly.
  {
    id: 'dresel',
    endpoint: (points) => {
      const region = DRESEL_REGIONS.find(([, box]) => within(points, box));
      return region ? `https://ovp.dresel.systems/${region[0]}/interpreter` : null;
    },
    contact: false,
  },
  // VK Maps: free, "no requests limitations".
  { id: 'vk', endpoint: fixed('https://maps.mail.ru/osm/tools/overpass/api/interpreter'), contact: false },
  // The main server is often overloaded and asks apps to use alternatives, so it's last and capped.
  { id: 'overpass-api.de', endpoint: fixed('https://overpass-api.de/api/interpreter'), contact: false, dailyMetric: 'overpass-api.de' },
];

/** A server's recent failures; stored per server in the D1 cache table. */
export interface Health {
  failures: number;
  /** Skip the server until then (ms since epoch). */
  until: number;
}

const FIRST_PAUSE_SEC = 300;
const MAX_PAUSE_SEC = 3600;

/** The health after one more failure: a pause that doubles each time, from 5 minutes up to an hour. */
export function failed(health: Health | null, now = Date.now()): Health {
  const failures = (health?.failures ?? 0) + 1;
  const pauseSec = Math.min(FIRST_PAUSE_SEC * 2 ** (failures - 1), MAX_PAUSE_SEC);
  return { failures, until: now + pauseSec * 1000 };
}
