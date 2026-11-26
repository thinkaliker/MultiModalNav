import { api, ApiError, AuthError, type DriveTiming, type PlanParams } from './api';
import { fmtDuration } from './format';
import { fmtLatLon, haversineKm, tileCenter, tileHalfDiagonalKm } from './geo';
import { isCarFirst, modeColor, modeTextColor, motisTransitModes, STREET_MODES } from './modes';
import { decodePolyline } from './polyline';
import { stationsNear } from './stations';
import type {
  DisplayLeg,
  LegCombo,
  PlanOffset,
  LatLon,
  MotisItinerary,
  MotisLeg,
  MotisPlace,
  NamedPlace,
  PlanResponse,
  SearchUsage,
  TomTomRouteResponse,
  TripOption,
  TripRequest,
  TripSettings,
  UpstreamCounts,
} from './types';

// Rough speeds used only to pre-rank candidate stations and as a fallback without traffic data.
const DRIVE_KMH = 40;
const TRANSIT_KMH = 30;
const ROAD_FACTOR = 1.3;
const TRANSIT_FACTOR = 1.25;
// Getting out of a car at the curb and walking to (or from) the platform.
const CURB_SEC = 60;
const MAX_RIDESHARE_STATIONS = 6;
// Picking a station next door to one already picked on the same kind of line (say, two adjacent
// light rail stops) wastes a comparison slot on what's nearly the same trip.
const MIN_STATION_SPACING_KM = 1;
// Of those, the ones closest to the destination: the shortest (cheapest) rideshares.
const CLOSEST_RIDESHARE_STATIONS = 3;
// Straight-line reach of a rideshare of a given length, generous for city driving; TomTom checks it.
const rideshareReachKm = (minutes: number) => (minutes / 60) * 40;
const CORRIDOR_BANDS = 3;
// What a transfer is worth in travel time: another line has to save more than this to be preferred.
export const TRANSFER_PENALTY_SEC = 5 * 60;
// Rideshare minutes cost money, so each counts this much extra (1 = double) in what Transitous
// optimizes and in the ranking: a longer rideshare has to save real time to be chosen.
export const RIDESHARE_COST_FACTOR = 1;
// A second query for more stations runs only if the first one's answers use fewer than this.
const MIN_COMPARED_STATIONS = 2;
// TomTom lookups per search for leaving transit early (see preferEarlyExits).
const MAX_EXIT_LOOKUPS = 4;

export interface Candidate {
  key: string;
  stopId: string;
  name: string;
  station: LatLon;
  /** Where the car stops: a parking lot found by Transitous, or the station itself. */
  park: LatLon;
  /** Walk from the parking spot to the platform, when known. */
  walkSec: number;
  source: 'discovery' | 'nearby';
  /** Transit modes stopping here, when known. */
  modes?: string[];
  /** Heuristic door-to-door estimate in seconds, used for ranking only. */
  estimateSec: number;
}

export interface Drive {
  seconds: number;
  delaySec: number;
  distanceM: number;
  coords: [number, number][];
  estimated: boolean;
}

export interface PlanResult {
  options: TripOption[];
  direct: TripOption[];
  notes: string[];
  usage: SearchUsage;
}

// Straight-line reach of a drive; generous because freeways cover ground quickly.
export const maxDriveKm = (maxMinutes: number) => Math.min(maxMinutes * 1.1, 100);

const CORRIDOR_FACTOR = 1.6;
const CORRIDOR_SLACK_KM = 4;

/** Whether going via `point` stays within the detour allowed between `from` and `to`. */
export function inCorridor(from: LatLon, to: LatLon, point: LatLon, slackKm = 0): boolean {
  const limit = CORRIDOR_FACTOR * haversineKm(from, to) + CORRIDOR_SLACK_KM + slackKm;
  return haversineKm(from, point) + haversineKm(point, to) <= limit;
}

export function estimateSec(from: LatLon, to: LatLon, station: LatLon): number {
  const drive = (haversineKm(from, station) * ROAD_FACTOR) / DRIVE_KMH;
  const ride = (haversineKm(station, to) * TRANSIT_FACTOR) / TRANSIT_KMH;
  return Math.round((drive + ride) * 3600);
}

/** Parking right next to the destination is just driving the whole way. */
const nearDestination = (from: LatLon, to: LatLon, station: LatLon) =>
  haversineKm(station, to) < Math.max(1.5, 0.12 * haversineKm(from, to));

/** Estimated door-to-door seconds via `station`, or null if it's out of range or off the corridor. */
export function scoreStation(from: LatLon, to: LatLon, station: LatLon, maxKm: number): number | null {
  if (haversineKm(from, station) > maxKm || !inCorridor(from, to, station) || nearDestination(from, to, station)) return null;
  return estimateSec(from, to, station);
}

/** Stations Transitous itself chose for a park-and-ride search (static drive times). */
export function discoveryCandidates(plan: PlanResponse, from: LatLon, to: LatLon): Candidate[] {
  const out: Candidate[] = [];
  for (const it of plan.itineraries) {
    const transitIndex = it.legs.findIndex((l) => !STREET_MODES.has(l.mode));
    const car = it.legs[0];
    if (transitIndex <= 0 || car.mode !== 'CAR') continue;
    const board = it.legs[transitIndex].from;
    const stopId = board.parentId ?? board.stopId;
    if (!stopId || out.some((c) => c.key === stopId) || nearDestination(from, to, board)) continue;
    const walkSec = it.legs.slice(1, transitIndex).reduce((sum, l) => sum + (l.mode === 'WALK' ? l.duration : 0), 0);
    out.push({
      key: stopId,
      stopId,
      name: board.name,
      station: { lat: board.lat, lon: board.lon },
      park: { lat: car.to.lat, lon: car.to.lon },
      walkSec,
      source: 'discovery',
      estimateSec: estimateSec(from, to, board),
    });
  }
  return out;
}

export function pickCandidates(
  nearby: MotisPlace[],
  discovered: Candidate[],
  from: LatLon,
  to: LatLon,
  maxKm: number,
  count: number,
  closest = 0,
): Candidate[] {
  const ranked: Candidate[] = [];
  for (const s of nearby) {
    if (!s.stopId) continue;
    const score = scoreStation(from, to, s, maxKm);
    if (score === null) continue;
    ranked.push({
      key: s.stopId,
      stopId: s.stopId,
      name: s.name,
      station: { lat: s.lat, lon: s.lon },
      park: { lat: s.lat, lon: s.lon },
      walkSec: 0,
      source: 'nearby',
      estimateSec: score,
      modes: s.modes,
    });
  }
  ranked.sort((a, b) => a.estimateSec - b.estimateSec);

  // Spread picks along the corridor (near home, midway, near the destination) so the
  // comparison isn't dominated by one stretch of line; the rough estimate can't be trusted
  // to choose between them, real drive and transit times will.
  const bands: Candidate[][] = Array.from({ length: CORRIDOR_BANDS }, () => []);
  for (const c of ranked) {
    const toStation = haversineKm(from, c.station);
    const progress = toStation / (toStation + haversineKm(c.station, to));
    bands[Math.min(CORRIDOR_BANDS - 1, Math.floor(progress * CORRIDOR_BANDS))].push(c);
  }

  const picked: Candidate[] = [];
  const sameLineKind = (a: Candidate, b: Candidate) => !!a.modes?.some((m) => b.modes?.includes(m));
  const isDuplicate = (c: Candidate) =>
    picked.some(
      (p) =>
        p.key === c.key ||
        (p.name === c.name && haversineKm(p.station, c.station) < 0.4) ||
        (sameLineKind(p, c) && haversineKm(p.station, c.station) < MIN_STATION_SPACING_KM),
    );
  const take = (c: Candidate | undefined) => {
    if (c && picked.length < count && !isDuplicate(c)) picked.push(c);
  };
  discovered.forEach(take);
  // The `closest` stations to `from` first, then the spread along the corridor.
  [...ranked]
    .sort((a, b) => haversineKm(from, a.station) - haversineKm(from, b.station))
    .slice(0, closest)
    .forEach(take);
  while (picked.length < count && bands.some((b) => b.length)) {
    for (const band of bands) {
      while (band.length) {
        const before = picked.length;
        take(band.shift());
        if (picked.length > before) break;
      }
    }
  }
  return picked;
}

export function driveFromTomTom(res: TomTomRouteResponse): Drive {
  const route = res.routes[0];
  return {
    seconds: route.summary.travelTimeInSeconds,
    delaySec: route.summary.trafficDelayInSeconds ?? 0,
    distanceM: route.summary.lengthInMeters,
    coords: route.legs.flatMap((leg) => leg.points.map((p) => [p.longitude, p.latitude] as [number, number])),
    estimated: false,
  };
}

export function estimateDrive(from: LatLon, to: LatLon): Drive {
  const km = haversineKm(from, to) * ROAD_FACTOR;
  return {
    seconds: Math.round((km / DRIVE_KMH) * 3600),
    delaySec: 0,
    distanceM: Math.round(km * 1000),
    coords: [
      [from.lon, from.lat],
      [to.lon, to.lat],
    ],
    estimated: true,
  };
}

/**
 * Indexes of drives within `limitSec`. If none fit (heavy traffic, say), keep the `fallback`
 * shortest ones so there's still something to compare; `relaxed` says that happened.
 */
export function withinLimit(drives: Drive[], limitSec: number, fallback = 1): { keep: number[]; relaxed: boolean } {
  const keep = drives.flatMap((d, i) => (d.seconds <= limitSec ? [i] : []));
  if (keep.length) return { keep, relaxed: false };
  const shortest = drives
    .map((d, i) => [d.seconds, i] as const)
    .sort((a, b) => a[0] - b[0])
    .slice(0, fallback)
    .map(([, i]) => i);
  return { keep: shortest, relaxed: true };
}

// Generous straight-line speeds for walking and biking, used only to rule out legs that can't
// reach any station (a station's map position can be a little off its platforms, hence the slack).
const REACH_KMH: Record<string, number> = { WALK: 5.5, BIKE: 20, RENTAL: 20 };
const REACH_SLACK_KM = 0.3;
const REACH_WORDS: Record<string, string> = { WALK: 'walk', BIKE: 'bike ride', RENTAL: 'bike/scooter ride' };
// Transitous's default limit for walking or biking the whole way (maxDirectTime).
const DIRECT_MAX_MIN = 30;

/** Straight-line reach of a walk/bike leg of `minutes`; null for modes without a fixed speed. */
export function reachKm(mode: string, minutes: number): number | null {
  const kmh = REACH_KMH[mode];
  return kmh ? (kmh * minutes) / 60 + REACH_SLACK_KM : null;
}

/** Whether any of `stations` could be reached from `place` by `mode` within `minutes`. */
export function canReachStation(stations: LatLon[], place: LatLon, mode: string, minutes: number): boolean {
  const km = reachKm(mode, minutes);
  return km === null || stations.some((s) => haversineKm(s, place) <= km);
}

/** Stops ridden on transit, over all of an itinerary's transit legs. */
export function transitStops(it: MotisItinerary): number {
  return it.legs.reduce((n, l) => n + (STREET_MODES.has(l.mode) ? 0 : (l.intermediateStops?.length ?? 0) + 1), 0);
}

// With offsets, the first and last legs are the injected ones: the first ends where the trip
// boards transit, the last starts where it gets off.
export const boardingPlace = (it: MotisItinerary): MotisPlace | undefined => it.legs[0]?.to;
export const exitPlace = (it: MotisItinerary): MotisPlace | undefined => it.legs[it.legs.length - 1]?.from;

/** `offsets` without the stops at `places` (Transitous reports child stops; offsets may name the parent). */
export function offsetsAvoiding(places: (MotisPlace | undefined)[], offsets: PlanOffset[]): PlanOffset[] {
  const ids = new Set<string>();
  for (const p of places) {
    if (p?.stopId) ids.add(p.stopId);
    if (p?.parentId) ids.add(p.parentId);
  }
  return offsets.filter((o) => !ids.has(o.stopId));
}

/** Itineraries grouped by the candidate station they board at (keys index into `candidates`). */
export function groupByBoarding(its: MotisItinerary[], candidates: Candidate[]): Map<number, MotisItinerary[]> {
  const groups = new Map<number, MotisItinerary[]>();
  for (const it of its) {
    const board = it.legs[0]?.mode === 'CAR' ? it.legs[0].to : undefined;
    if (!board) continue;
    let i = candidates.findIndex((c) => c.stopId === board.stopId || c.stopId === board.parentId || c.key === board.parentId);
    if (i < 0) {
      const dist = candidates.map((c) => haversineKm(c.station, board));
      const nearest = dist.indexOf(Math.min(...dist));
      if (dist[nearest] < 0.5) i = nearest;
    }
    if (i >= 0) groups.set(i, [...(groups.get(i) ?? []), it]);
  }
  return groups;
}

/**
 * Lower is better: arrival (or, for "arrive by", a late departure) plus a penalty per transfer
 * and `extraSec` for anything else that costs (rideshare minutes, say).
 */
export function tripCost(arriveBy: boolean, startTime: string, endTime: string, transfers: number, extraSec = 0): number {
  return (arriveBy ? -ms(startTime) : ms(endTime)) / 1000 + transfers * TRANSFER_PENALTY_SEC + extraSec;
}

const rideshareSec = (o: TripOption) => o.legs.reduce((n, l) => n + (l.mode === 'RIDESHARE' ? l.durationSec : 0), 0);

/** `tripCost` of an option, counting its rideshare minutes (see RIDESHARE_COST_FACTOR). */
export const optionCost = (arriveBy: boolean, o: TripOption) =>
  tripCost(arriveBy, o.startTime, o.endTime, o.transfers, RIDESHARE_COST_FACTOR * rideshareSec(o));

/** A copy of `it` starting `sec` later, its first (injected) leg that much shorter. */
export function startLater(it: MotisItinerary, sec: number): MotisItinerary {
  if (!sec) return it;
  const [first, ...rest] = it.legs;
  const start = ms(first.startTime) + sec * 1000;
  return {
    ...it,
    legs: [{ ...first, startTime: iso(start), scheduledStartTime: iso(start), duration: first.duration - sec }, ...rest],
    startTime: iso(start),
    duration: it.duration - sec,
  };
}

/** A copy of `it` whose last (injected) leg lasts `lastSec` instead. */
export function endWithLeg(it: MotisItinerary, lastSec: number): MotisItinerary {
  const last = it.legs[it.legs.length - 1];
  const end = ms(last.startTime) + lastSec * 1000;
  return {
    ...it,
    legs: [...it.legs.slice(0, -1), { ...last, endTime: iso(end), scheduledEndTime: iso(end), duration: lastSec }],
    endTime: iso(end),
    duration: Math.round((end - ms(it.startTime)) / 1000),
  };
}

const stopCount = (leg: MotisLeg) => (leg.intermediateStops?.length ?? 0) + 1;

/** Where a trip could leave transit early: after each transit leg but the last, with the stops ridden by then. */
export function earlyExits(it: MotisItinerary): { legIndex: number; stops: number }[] {
  const transit = it.legs.flatMap((l, i) => (STREET_MODES.has(l.mode) ? [] : [i]));
  let stops = 0;
  return transit.slice(0, -1).map((legIndex) => ({ legIndex, stops: (stops += stopCount(it.legs[legIndex])) }));
}

// An option is noise if another one leaves within DOMINANCE_SLACK_SEC of it (or, for "arrive
// by", arrives within that) and still comes out ahead by DOMINANCE_MARGIN_SEC or more. Smaller
// gaps stay, so the station comparison is still there.
const DOMINANCE_SLACK_SEC = 5 * 60;
const DOMINANCE_MARGIN_SEC = 15 * 60;

/** How long the rideshare at the end of an option takes (0 if it doesn't end with one). */
const finalRideSec = (o: TripOption) => {
  const last = o.legs[o.legs.length - 1];
  return last?.mode === 'RIDESHARE' ? last.durationSec : 0;
};

/**
 * Whether a drive-park-transit-rideshare option is pointless next to parking near the destination
 * and taking a rideshare from there: it takes DOMINANCE_MARGIN_SEC longer or more, while the
 * transit saves neither driving nor rideshare (each within TRANSFER_PENALTY_SEC). If parking
 * near the destination means driving clearly further, the transit is doing its job.
 */
export function slowerThanParkAndRideshare(option: TripOption, parkAndRideshare: TripOption): boolean {
  const ride = finalRideSec(option);
  const drive = option.traffic?.driveSec ?? 0;
  return (
    ride > 0 &&
    option.durationSec >= parkAndRideshare.durationSec + DOMINANCE_MARGIN_SEC &&
    finalRideSec(parkAndRideshare) <= ride + TRANSFER_PENALTY_SEC &&
    (parkAndRideshare.traffic?.driveSec ?? Infinity) <= drive + TRANSFER_PENALTY_SEC
  );
}

/** Options without the ones another option clearly beats (see DOMINANCE_MARGIN_SEC). */
export function dropDominated(options: TripOption[], arriveBy: boolean): TripOption[] {
  const slack = DOMINANCE_SLACK_SEC * 1000;
  const cost = (o: TripOption) => optionCost(arriveBy, o);
  const sameTime = (a: TripOption, b: TripOption) =>
    arriveBy ? ms(a.endTime) >= ms(b.endTime) - slack : ms(a.startTime) >= ms(b.startTime) - slack;
  return options.filter((b) => !options.some((a) => a !== b && sameTime(a, b) && cost(a) + DOMINANCE_MARGIN_SEC <= cost(b)));
}

/** The trip cut short after leg `legIndex`, finishing with a car leg of `lastMileSec` from there. */
export function exitEarly(it: MotisItinerary, legIndex: number, lastMileSec: number): MotisItinerary {
  const exit = it.legs[legIndex];
  const start = ms(exit.endTime);
  const end = start + lastMileSec * 1000;
  const car: MotisLeg = {
    mode: 'CAR',
    from: exit.to,
    to: it.legs[it.legs.length - 1].to,
    startTime: iso(start),
    endTime: iso(end),
    scheduledStartTime: iso(start),
    scheduledEndTime: iso(end),
    realTime: false,
    duration: lastMileSec,
    legGeometry: { points: '', precision: 6, length: 0 },
  };
  const legs = [...it.legs.slice(0, legIndex + 1), car];
  return {
    ...it,
    legs,
    endTime: iso(end),
    duration: Math.round((end - ms(it.startTime)) / 1000),
    transfers: legs.filter((l) => !STREET_MODES.has(l.mode)).length - 1,
  };
}

/** Whether a trip passes through a station it already left, like riding one stop out and back. */
export function revisitsStation(it: MotisItinerary): boolean {
  const seen = new Set<string>();
  let previous: string | undefined;
  for (const leg of it.legs) {
    if (STREET_MODES.has(leg.mode)) continue;
    for (const p of [leg.from, ...(leg.intermediateStops ?? []), leg.to]) {
      const key = p.parentId ?? p.stopId ?? `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
      // The same station twice in a row is a change of lines there, not a revisit.
      if (key === previous) continue;
      if (seen.has(key)) return true;
      seen.add(key);
      previous = key;
    }
  }
  return false;
}

/** TomTom wants an RFC 3339 time in the future, or "now". */
export function driveTiming(departure: Date, now = Date.now()): DriveTiming {
  if (departure.getTime() <= now + 60_000) return { departAt: 'now' };
  return { departAt: departure.toISOString().replace(/\.\d{3}Z$/, '+00:00') };
}

const addSec = (date: Date, sec: number) => new Date(date.getTime() + sec * 1000);
const iso = (msSinceEpoch: number) => new Date(msSinceEpoch).toISOString();
const ms = (time: string) => Date.parse(time);

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function placeName(p: MotisPlace, req: TripRequest): string {
  if (p.name === 'START') return req.from.name;
  if (p.name === 'END') return req.to.name;
  return p.name;
}

const STREET_VERB: Record<string, string> = { WALK: 'Walk', BIKE: 'Bike', RENTAL: 'Ride share bike/scooter', CAR: 'Drive' };

export function toDisplayLeg(leg: MotisLeg, req: TripRequest): DisplayLeg {
  const transit = !STREET_MODES.has(leg.mode);
  const from: NamedPlace = { name: placeName(leg.from, req), lat: leg.from.lat, lon: leg.from.lon };
  const to: NamedPlace = { name: placeName(leg.to, req), lat: leg.to.lat, lon: leg.to.lon };
  let coords = leg.legGeometry?.points ? decodePolyline(leg.legGeometry.points, leg.legGeometry.precision) : [];
  if (coords.length < 2) coords = [[from.lon, from.lat], [to.lon, to.lat]];
  const routeName = leg.routeShortName || leg.displayName || leg.routeLongName || leg.mode;
  return {
    mode: leg.mode,
    label: transit
      ? `${routeName}${leg.headsign ? ` toward ${leg.headsign}` : ''}`
      : `${STREET_VERB[leg.mode] ?? 'Go'} to ${to.name}`,
    startTime: leg.startTime,
    endTime: leg.endTime,
    durationSec: leg.duration,
    from,
    to,
    tz: leg.from.tz,
    coords,
    color: modeColor(leg.mode, transit ? leg.routeColor : undefined),
    textColor: modeTextColor(transit ? leg.routeTextColor : undefined),
    dashed: leg.mode === 'WALK',
    realTime: leg.realTime,
    routeShortName: transit ? routeName : undefined,
    headsign: leg.headsign,
    agencyName: leg.agencyName,
    stopCount: transit ? (leg.intermediateStops?.length ?? 0) + 1 : undefined,
    track: leg.from.track,
    distanceM: leg.distance,
    cancelled: leg.cancelled,
    alerts: leg.alerts?.map((a) => a.headerText ?? a.descriptionText ?? '').filter(Boolean),
  };
}

/** A leg with no transit details: waiting, parking, driving, riding. */
function streetLeg(
  mode: string,
  label: string,
  start: number,
  end: number,
  from: NamedPlace,
  to: NamedPlace,
  extra: Partial<DisplayLeg> = {},
): DisplayLeg {
  return {
    mode,
    label,
    startTime: iso(start),
    endTime: iso(end),
    durationSec: Math.round((end - start) / 1000),
    from,
    to,
    coords: [],
    color: modeColor(mode),
    textColor: '#ffffff',
    dashed: mode === 'WAIT' || mode === 'PARK',
    realTime: false,
    ...extra,
  };
}

function driveExtras(drive: Drive): Partial<DisplayLeg> {
  return {
    coords: drive.coords,
    distanceM: drive.distanceM,
    trafficDelaySec: drive.delaySec,
    trafficEstimated: drive.estimated,
  };
}

/** Rideshare from the last transit stop: computed by the app and passed to Transitous as `toOffsets`. */
export interface LastMile {
  candidates: Candidate[];
  drives: Drive[];
  waitSec: number;
  offsets: PlanOffset[];
}

interface Ride {
  station: NamedPlace;
  drive: Drive;
}

/** Rideshares the app added itself when leaving transit early, keyed by their injected leg. */
const earlyExitRides = new WeakMap<MotisLeg, Ride>();

/** The rideshare behind an injected last leg from `toOffsets`. */
function offsetRide(leg: MotisLeg, lastMile: LastMile): Ride {
  const key = leg.from.parentId ?? leg.from.stopId;
  let index = lastMile.candidates.findIndex((c) => c.key === key || c.stopId === leg.from.stopId);
  if (index < 0) {
    // Fall back to the closest candidate if Transitous reports a child stop we didn't send.
    const dist = lastMile.candidates.map((c) => haversineKm(c.station, leg.from));
    index = dist.indexOf(Math.min(...dist));
  }
  const station = lastMile.candidates[index];
  return { station: { name: station.name, ...station.station }, drive: lastMile.drives[index] };
}

function rideshareLastLegs(leg: MotisLeg, req: TripRequest, { station: stationPlace, drive }: Ride): DisplayLeg[] {
  const end = ms(leg.endTime);
  const rideStart = end - drive.seconds * 1000;
  return [
    streetLeg('WAIT', 'Walk to the pickup spot and wait for your ride', ms(leg.startTime), rideStart, stationPlace, stationPlace, {
      tz: leg.from.tz,
    }),
    streetLeg('RIDESHARE', `Rideshare to ${req.to.name}`, rideStart, end, stationPlace, req.to, {
      tz: leg.from.tz,
      ...driveExtras(drive),
    }),
  ];
}

/** Convert Transitous legs, swapping its placeholder for a rideshare last mile if one was injected. */
export function displayLegs(legs: MotisLeg[], req: TripRequest, lastMile?: LastMile): DisplayLeg[] {
  return legs.flatMap((leg, i) => {
    // Callers strip any first-mile car leg, so a trailing CAR leg here is always an injected rideshare.
    const injected = i === legs.length - 1 && leg.mode === 'CAR';
    const ride = injected ? (earlyExitRides.get(leg) ?? (lastMile && offsetRide(leg, lastMile))) : undefined;
    return ride ? rideshareLastLegs(leg, req, ride) : [toDisplayLeg(leg, req)];
  });
}

/** Seconds of rideshare in an itinerary's injected last leg (0 if it has none). */
function lastRideSec(it: MotisItinerary, lastMile?: LastMile): number {
  const last = it.legs[it.legs.length - 1];
  if (last?.mode !== 'CAR') return 0;
  const ride = earlyExitRides.get(last) ?? (lastMile && offsetRide(last, lastMile));
  return ride?.drive.seconds ?? 0;
}

function sortItineraries(its: MotisItinerary[], arriveBy: boolean, lastMile?: LastMile): MotisItinerary[] {
  const cost = (it: MotisItinerary) =>
    tripCost(arriveBy, it.startTime, it.endTime, it.transfers, RIDESHARE_COST_FACTOR * lastRideSec(it, lastMile));
  return [...its].sort((a, b) => cost(a) - cost(b) || a.duration - b.duration);
}

function sortOptions(options: TripOption[], arriveBy: boolean): TripOption[] {
  return [...options].sort((a, b) => optionCost(arriveBy, a) - optionCost(arriveBy, b) || a.durationSec - b.durationSec);
}

function alternativesOf(sorted: MotisItinerary[]): TripOption['alternatives'] {
  const seen = new Set<string>();
  return sorted
    .slice(1)
    .filter((it) => {
      const key = `${it.startTime}|${it.endTime}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => ms(a.startTime) - ms(b.startTime))
    .slice(0, 5)
    .map((it) => ({ startTime: it.startTime, endTime: it.endTime }));
}

const rideshareWaitSec = (req: TripRequest) => req.rideshareWaitMin * 60;

/** Everything between leaving the start and the platform, beyond the drive itself. */
export function firstLegBufferSec(req: LegCombo): number {
  if (req.firstLeg === 'CAR_PARKING') return req.parkBufferMin * 60;
  if (req.firstLeg === 'RIDESHARE') return rideshareWaitSec(req) + CURB_SEC;
  return CURB_SEC;
}

const FIRST_LEG_TITLE: Record<string, string> = { CAR_PARKING: 'Park at', CAR_DROPOFF: 'Drop-off at', RIDESHARE: 'Rideshare to' };
const FIRST_LEG_VERB: Record<string, string> = { CAR_PARKING: 'Drive to', CAR_DROPOFF: 'Get dropped off at', RIDESHARE: 'Rideshare to' };

export function buildParkRideOption(
  req: LegCombo,
  candidate: Candidate,
  drive: Drive,
  offsetSec: number,
  plan: PlanResponse,
  lastMile?: LastMile,
): TripOption | null {
  const its = sortItineraries(
    plan.itineraries.filter((it) => it.legs.length > 1 && it.legs[0].mode === 'CAR'),
    req.arriveBy,
    lastMile,
  );
  const best = its[0];
  if (!best) return null;

  const [carLeg, ...rest] = best.legs;
  const tz = rest[0]?.from.tz;
  const waitSec = req.firstLeg === 'RIDESHARE' ? rideshareWaitSec(req) : 0;
  const driveStart = ms(carLeg.startTime) + waitSec * 1000;
  const driveEnd = driveStart + drive.seconds * 1000;
  const dropPoint: NamedPlace = { name: candidate.name, ...candidate.park };
  const legs: DisplayLeg[] = [];
  if (waitSec) legs.push(streetLeg('WAIT', 'Wait for your ride', ms(carLeg.startTime), driveStart, req.from, req.from, { tz }));
  legs.push(
    streetLeg(req.firstLeg === 'RIDESHARE' ? 'RIDESHARE' : 'CAR', `${FIRST_LEG_VERB[req.firstLeg] ?? 'Drive to'} ${candidate.name}`, driveStart, driveEnd, req.from, dropPoint, {
      tz,
      ...driveExtras(drive),
    }),
  );
  if (req.firstLeg === 'CAR_PARKING') {
    const walkPath: [number, number][] =
      haversineKm(candidate.park, candidate.station) > 0.02
        ? [
            [candidate.park.lon, candidate.park.lat],
            [candidate.station.lon, candidate.station.lat],
          ]
        : [];
    legs.push(
      streetLeg('PARK', 'Park and walk to the platform', driveEnd, ms(carLeg.endTime), { ...dropPoint, name: 'Parking' }, {
        name: candidate.name,
        ...candidate.station,
      }, { tz, coords: walkPath }),
    );
  }
  legs.push(...displayLegs(rest, req, lastMile));

  return {
    id: `parkride:${req.firstLeg}:${req.lastLeg}:${candidate.key}`,
    kind: 'parkride',
    title: `${FIRST_LEG_TITLE[req.firstLeg] ?? 'Via'} ${candidate.name}`,
    startTime: best.startTime,
    endTime: best.endTime,
    durationSec: best.duration,
    transfers: best.transfers,
    legs,
    station: { name: candidate.name, ...candidate.station },
    alternatives: alternativesOf(its),
    traffic: {
      label: req.firstLeg === 'RIDESHARE' ? 'Ride' : 'Drive',
      driveSec: drive.seconds,
      delaySec: drive.delaySec,
      estimated: drive.estimated,
    },
    realTime: legs.some((l) => l.realTime),
  };
}

export function itineraryOption(req: TripRequest, it: MotisItinerary, id: string, lastMile?: LastMile): TripOption {
  const legs = displayLegs(it.legs, req, lastMile);
  const board = it.legs.find((l) => !STREET_MODES.has(l.mode));
  const first = it.legs[0];
  let title = `${STREET_VERB[first?.mode] ?? 'Go'} the whole way`;
  if (board) {
    const station = placeName(board.from, req);
    title = first === board ? `Board at ${station}` : `${STREET_VERB[first.mode] ?? 'Go'} to ${station}`;
  }
  return {
    id,
    kind: board ? 'transit' : 'direct',
    title,
    startTime: it.startTime,
    endTime: it.endTime,
    durationSec: it.duration,
    transfers: it.transfers,
    legs,
    station: board ? { name: board.from.name, lat: board.from.lat, lon: board.from.lon } : undefined,
    alternatives: [],
    realTime: legs.some((l) => l.realTime),
  };
}

function directCarOption(req: LegCombo, drive: Drive): TripOption {
  const rideshare = req.firstLeg === 'RIDESHARE';
  const waitSec = rideshare ? rideshareWaitSec(req) : 0;
  const totalSec = waitSec + drive.seconds;
  const anchor = (req.time ?? new Date()).getTime();
  const start = req.arriveBy ? anchor - totalSec * 1000 : anchor;
  const driveStart = start + waitSec * 1000;
  const end = start + totalSec * 1000;
  const legs: DisplayLeg[] = [];
  if (waitSec) legs.push(streetLeg('WAIT', 'Wait for your ride', start, driveStart, req.from, req.from));
  legs.push(
    streetLeg(rideshare ? 'RIDESHARE' : 'CAR', `${rideshare ? 'Rideshare' : 'Drive'} to ${req.to.name}`, driveStart, end, req.from, req.to, driveExtras(drive)),
  );
  return {
    id: rideshare ? 'direct:rideshare' : 'direct:car',
    kind: 'direct',
    title: rideshare ? 'Rideshare the whole way' : 'Drive the whole way',
    startTime: iso(start),
    endTime: iso(end),
    durationSec: totalSec,
    transfers: 0,
    legs,
    alternatives: [],
    traffic: { label: rideshare ? 'Ride' : 'Drive', driveSec: drive.seconds, delaySec: drive.delaySec, estimated: drive.estimated },
    realTime: false,
  };
}

/** Drive to a station lot near the destination, park, and rideshare the rest: no transit at all. */
export function buildParkAndRideshareOption(
  req: TripRequest,
  hub: Candidate,
  drive: Drive,
  ride: Drive,
): TripOption {
  const parkSec = req.parkBufferMin * 60 + CURB_SEC;
  const waitSec = rideshareWaitSec(req);
  const totalSec = drive.seconds + parkSec + waitSec + ride.seconds;
  const anchor = (req.time ?? new Date()).getTime();
  const start = req.arriveBy ? anchor - totalSec * 1000 : anchor;
  const parked = start + drive.seconds * 1000;
  const atPickup = parked + parkSec * 1000;
  const pickedUp = atPickup + waitSec * 1000;
  const end = start + totalSec * 1000;
  const hubPlace: NamedPlace = { name: hub.name, ...hub.station };
  return {
    id: `parkrideshare:${hub.key}`,
    kind: 'parkride',
    title: `Park at ${hub.name}, rideshare the rest`,
    startTime: iso(start),
    endTime: iso(end),
    durationSec: totalSec,
    transfers: 0,
    legs: [
      streetLeg('CAR', `Drive to ${hub.name}`, start, parked, req.from, hubPlace, driveExtras(drive)),
      streetLeg('PARK', 'Park and walk to the pickup spot', parked, atPickup, { ...hubPlace, name: 'Parking' }, hubPlace),
      streetLeg('WAIT', 'Wait for your ride', atPickup, pickedUp, hubPlace, hubPlace),
      streetLeg('RIDESHARE', `Rideshare to ${req.to.name}`, pickedUp, end, hubPlace, req.to, driveExtras(ride)),
    ],
    station: hubPlace,
    alternatives: [],
    traffic: { label: 'Drive', driveSec: drive.seconds, delaySec: drive.delaySec, estimated: drive.estimated },
    realTime: false,
  };
}

function baseParams(req: LegCombo): PlanParams {
  return {
    fromPlace: fmtLatLon(req.from),
    toPlace: fmtLatLon(req.to),
    time: (req.time ?? new Date()).toISOString(),
    arriveBy: req.arriveBy,
    transitModes: motisTransitModes(req.transit).join(','),
    // A rideshare last mile is sent as toOffsets, which replace this.
    postTransitModes: req.lastLeg === 'RIDESHARE' ? 'WALK' : req.lastLeg,
    maxPostTransitTime: req.maxLastLegMin * 60,
  };
}

interface PlanOptions {
  trafficEnabled: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

/** State shared by all leg combinations of one search, so lookups aren't repeated. */
interface PlanContext extends PlanOptions {
  usage: SearchUsage;
  /** Caps concurrent Transitous queries across the whole search. */
  transitousSlot: Limiter;
  notes: string[];
  driver: Driver;
  /** Transitous's own park-and-ride / drop-off pick, per first-mile mode. */
  discovery(req: LegCombo, mode: string): Promise<PlanResponse | null>;
  /** Rideshare options from stations near the destination, computed once. */
  lastMile(): Promise<LastMile | undefined>;
  /** Whether a walk/bike leg at the start or destination can reach a station at all. */
  reaches(mode: string, minutes: number, end: 'start' | 'destination'): Promise<boolean>;
  /** Note that trips with a leg that can't reach a station were skipped. */
  skipped(mode: string, minutes: number, end: 'start' | 'destination'): void;
  /** A rideshare from a transfer station to the destination; null once the lookup budget is spent. */
  exitRide(place: MotisPlace, departure: Date): Promise<Drive | null>;
  stats: { tooShort: number };
}

type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/** Runs at most `limit` tasks at a time. */
function makeLimiter(limit: number): Limiter {
  let active = 0;
  const queue: (() => void)[] = [];
  return async (task) => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

// Transitous answers bursts with HTTP 429, so keep a search's queries to a few at a time.
const TRANSITOUS_CONCURRENCY = 3;

type Offsets = Parameters<typeof api.planWithOffsets>[1];

/** Transitous plan queries, counted toward this search's usage. */
function planQuery(ctx: PlanContext, params: PlanParams, offsets?: Offsets): Promise<PlanResponse> {
  return ctx.transitousSlot(async () => {
    try {
      const { data, cached } = offsets
        ? await api.planWithOffsets(params, offsets, ctx.signal)
        : await api.plan(params, ctx.signal);
      ctx.usage[cached ? 'cached' : 'transitous']++;
      return data;
    } catch (err) {
      ctx.usage.transitous++;
      throw err;
    }
  });
}

/**
 * A plan query keeping only sensible trips: ones that ride at least `minTransitStops` stops and
 * don't loop back through a station. If none are left, ask once more without the stations the
 * others used: their boarding stations (`retryWithout: 'boarding'`, for a station list the app
 * chose) or the stations they got off at for a rideshare. The next-best is usually further along
 * the line. `tooShort` says there were trips, but none rode far enough; `short` lists every trip
 * dropped.
 */
async function planTransit(
  ctx: PlanContext,
  req: LegCombo,
  params: PlanParams,
  offsets?: Offsets,
  retryWithout: 'boarding' | 'exit' = 'exit',
): Promise<{ plan: PlanResponse; tooShort: boolean; short: MotisItinerary[] }> {
  const plan = await planQuery(ctx, params, offsets);
  if (!plan.itineraries.length) return { plan, tooShort: false, short: [] };
  const isShort = (it: MotisItinerary) => transitStops(it) < req.minTransitStops || revisitsStation(it);
  const short = plan.itineraries.filter(isShort);
  let kept: PlanResponse = { ...plan, itineraries: plan.itineraries.filter((it) => !isShort(it)) };
  const side = retryWithout === 'boarding' ? 'fromOffsets' : 'toOffsets';
  const list = offsets?.[side];
  if (!kept.itineraries.length && list) {
    const rest = offsetsAvoiding(short.map(retryWithout === 'boarding' ? boardingPlace : exitPlace), list);
    if (rest.length && rest.length < list.length) {
      const retry = await planQuery(ctx, params, { ...offsets, [side]: rest });
      short.push(...retry.itineraries.filter(isShort));
      kept = { ...retry, itineraries: retry.itineraries.filter((it) => !isShort(it)) };
    }
  }
  const tooShort = !kept.itineraries.length && short.some((it) => transitStops(it) < req.minTransitStops);
  return { plan: kept, tooShort, short };
}

function rethrowIfFatal(err: unknown, signal?: AbortSignal) {
  if (err instanceof AuthError || signal?.aborted) throw err;
}

// TomTom's free tier limits requests per second, so only a couple go out at once.
const TOMTOM_CONCURRENCY = 2;

/**
 * Traffic-aware drives via TomTom, de-duplicated within a search. A failed lookup falls back
 * to an estimate for that leg; TomTom is skipped entirely once the key is rejected or the
 * monthly limit is reached.
 */
function makeDriver({ trafficEnabled, signal, usage }: PlanOptions & { usage: SearchUsage }) {
  let disabled = !trafficEnabled;
  let anyFailed = !trafficEnabled;
  let limitReached = false;
  let lastError = '';
  const memo = new Map<string, Promise<Drive>>();
  const slot = makeLimiter(TOMTOM_CONCURRENCY);

  async function lookup(from: LatLon, to: LatLon, timing: DriveTiming): Promise<Drive> {
    try {
      if (disabled) return estimateDrive(from, to);
      const { data: res, cached } = await api.trafficRoute(from, to, timing, signal);
      usage[cached ? 'cached' : 'tomtom']++;
      if (res.routes?.length) return driveFromTomTom(res);
    } catch (err) {
      rethrowIfFatal(err, signal);
      anyFailed = true;
      lastError = (err as Error).message;
      if (err instanceof ApiError && err.status === 429 && err.message === 'monthly_limit_reached') {
        // The server refuses without calling TomTom once the monthly limit is reached.
        limitReached = true;
        disabled = true;
      } else {
        usage.tomtom++;
        // A rejected key won't start working mid-search.
        if (err instanceof ApiError && (err.upstreamStatus === 401 || err.upstreamStatus === 403)) disabled = true;
      }
    }
    return estimateDrive(from, to);
  }

  return {
    get failed() {
      return anyFailed;
    },
    get note(): string {
      if (!trafficEnabled) return 'Traffic is not configured (TOMTOM_API_KEY); car times are rough estimates.';
      if (limitReached) return 'The TomTom monthly limit has been reached; car times are estimates until next month.';
      return `Some traffic lookups failed${lastError ? ` (${lastError})` : ''}; those car times are estimates.`;
    },
    route(from: LatLon, to: LatLon, departure: Date): Promise<Drive> {
      const timing = driveTiming(departure);
      const key = `${fmtLatLon(from)}>${fmtLatLon(to)}@${timing.departAt}`;
      let pending = memo.get(key);
      if (!pending) {
        pending = slot(() => lookup(from, to, timing));
        memo.set(key, pending);
      }
      return pending;
    },
  };
}

type Driver = ReturnType<typeof makeDriver>;

/** Stations near the destination, each with a traffic-aware rideshare time to it. */
async function prepareRideshareLastMile(
  req: TripRequest,
  driver: Driver,
  notes: string[],
  signal?: AbortSignal,
): Promise<LastMile | undefined> {
  const maxKm = maxDriveKm(req.maxLastLegMin);
  const nearby = await stationsNear(req.to, maxKm, motisTransitModes(req.transit), (tile) =>
    inCorridor(req.to, req.from, tileCenter(tile), 2 * tileHalfDiagonalKm(tile)),
  ).catch((err) => {
    rethrowIfFatal(err, signal);
    return [] as MotisPlace[];
  });
  // Same ranking as for the first leg, seen from the destination's side, within rideshare reach,
  // and always including the closest stations: a shorter rideshare is a cheaper one.
  const reachKm = Math.min(maxKm, rideshareReachKm(req.maxLastLegMin));
  const candidates = pickCandidates(
    nearby.filter((s) => haversineKm(s, req.to) <= reachKm),
    [],
    req.to,
    req.from,
    maxKm,
    Math.min(req.stationsToCompare, MAX_RIDESHARE_STATIONS),
    CLOSEST_RIDESHARE_STATIONS,
  );
  if (!candidates.length) {
    notes.push(`No stations within about ${req.maxLastLegMin} minutes’ ride of the destination, so there are no rideshare options.`);
    return undefined;
  }
  const anchor = req.time ?? new Date();
  const waitSec = rideshareWaitSec(req);
  const drives = await mapLimit(candidates, 4, (c) => {
    const rideSec = estimateDrive(c.station, req.to).seconds;
    const departure = req.arriveBy
      ? addSec(anchor, -rideSec - waitSec)
      : addSec(anchor, c.estimateSec - rideSec); // rough time spent getting to this station
    return driver.route(c.station, req.to, departure);
  });
  const { keep, relaxed } = withinLimit(drives, req.maxLastLegMin * 60);
  if (relaxed) {
    notes.push(
      `No station is within ${req.maxLastLegMin} min by rideshare; using the closest (${fmtDuration(drives[keep[0]].seconds)}).`,
    );
  }
  const kept = keep.map((i) => ({ candidate: candidates[i], drive: drives[i] }));
  // Transitous sees each rideshare weighted by its cost, so it favours shorter ones; real times
  // are put back afterwards (realLastMile). "Arrive by" keeps real times, so you don't leave early.
  const weight = req.arriveBy ? 0 : RIDESHARE_COST_FACTOR;
  return {
    candidates: kept.map((k) => k.candidate),
    drives: kept.map((k) => k.drive),
    waitSec,
    offsets: kept.map(({ candidate, drive }) => ({
      stopId: candidate.stopId,
      duration: Math.round(CURB_SEC + waitSec + drive.seconds * (1 + weight)),
      mode: 'CAR' as const,
    })),
  };
}

/** Itineraries with their injected rideshare back to its real length (see the weighted offsets). */
function realLastMile(its: MotisItinerary[], lastMile: LastMile): MotisItinerary[] {
  return its.map((it) =>
    it.legs[it.legs.length - 1]?.mode === 'CAR'
      ? endWithLeg(it, CURB_SEC + lastMile.waitSec + offsetRide(it.legs[it.legs.length - 1], lastMile).drive.seconds)
      : it,
  );
}

/** How TomTom's rides here compare with the distance estimate (median ratio), to sharpen guesses. */
function rideScale(req: TripRequest, lastMile: LastMile): number {
  const ratios = lastMile.drives
    .flatMap((d, i) => (d.estimated ? [] : [d.seconds / Math.max(60, estimateDrive(lastMile.candidates[i].station, req.to).seconds)]))
    .sort((a, b) => a - b);
  return ratios.length ? ratios[Math.floor(ratios.length / 2)] : 1;
}

/**
 * Edge weighting on the trips Transitous found, with no further Transitous queries. For a trip
 * that changes lines before its rideshare, compare getting off at each change and riding from
 * there instead; every transfer costs TRANSFER_PENALTY_SEC, so the extra line stays only if it
 * saves more than that. Exits are screened with a distance estimate scaled to the TomTom rides
 * already known, and only promising ones get a TomTom lookup. A trip is dropped when its best
 * version leaves too early to ride `minTransitStops`: then neither version is worth taking.
 */
async function preferEarlyExits(
  ctx: PlanContext,
  req: LegCombo,
  its: MotisItinerary[],
  lastMile: LastMile,
): Promise<{ kept: MotisItinerary[]; dropped: MotisItinerary[] }> {
  const scale = rideScale(req, lastMile);
  const limitSec = req.maxLastLegMin * 60;
  const fixedSec = CURB_SEC + lastMile.waitSec;
  const deadline = req.arriveBy && req.time ? req.time.getTime() : Infinity;
  // Rideshare minutes count extra (RIDESHARE_COST_FACTOR): leaving early usually means a longer one.
  const costOf = (it: MotisItinerary, rideSec: number) =>
    tripCost(req.arriveBy, it.startTime, it.endTime, it.transfers, RIDESHARE_COST_FACTOR * rideSec);
  const worse = (it: MotisItinerary, rideSec: number, than: number) => ms(it.endTime) > deadline || costOf(it, rideSec) > than;

  const trimmed = await Promise.all(
    its.map(async (it): Promise<MotisItinerary | null> => {
      if (it.legs[it.legs.length - 1]?.mode !== 'CAR') return it;
      let best = it;
      let bestCost = costOf(it, lastRideSec(it, lastMile));
      let bestTooShort = false;
      for (const { legIndex: i, stops } of earlyExits(it)) {
        const exit = it.legs[i].to;
        const guessSec = estimateDrive(exit, req.to).seconds * scale;
        if (guessSec > limitSec || worse(exitEarly(it, i, fixedSec + guessSec), guessSec, bestCost)) continue;
        const drive = await ctx.exitRide(exit, new Date(ms(it.legs[i].endTime) + fixedSec * 1000));
        if (!drive || drive.seconds > limitSec) continue;
        const cut = exitEarly(it, i, fixedSec + drive.seconds);
        if (worse(cut, drive.seconds, bestCost)) continue;
        earlyExitRides.set(cut.legs[cut.legs.length - 1], { station: { name: exit.name, lat: exit.lat, lon: exit.lon }, drive });
        best = cut;
        bestCost = costOf(cut, drive.seconds);
        bestTooShort = stops < req.minTransitStops;
      }
      return bestTooShort ? null : best;
    }),
  );
  return {
    kept: trimmed.filter((it): it is MotisItinerary => it !== null),
    dropped: its.filter((_, i) => trimmed[i] === null),
  };
}

/** Upper-bound estimate of the upstream calls a search with these settings makes. */
export function estimateCost(s: TripSettings, trafficEnabled: boolean): UpstreamCounts {
  const car = s.firstLegs.filter(isCarFirst);
  const street = s.firstLegs.length - car.length;
  const discoveries = new Set(car.map((m) => (m === 'CAR_PARKING' ? 'CAR_PARKING' : 'CAR_DROPOFF'))).size;
  const rideshareLast = s.lastLegs.includes('RIDESHARE');
  const rideshareStations = Math.min(s.stationsToCompare, MAX_RIDESHARE_STATIONS);
  // A car first leg queries all its stations at once, plus maybe once more for a comparison
  // (see planCarFirst); with a minimum ride, each of those may need a retry (see planTransit).
  const carQueries = car.length * s.lastLegs.length * 2;
  const retries = s.minTransitStops > 1 ? carQueries + (rideshareLast ? street : 0) : 0;
  const transitous = discoveries + carQueries + street * s.lastLegs.length + retries;
  let tomtom = 0;
  if (trafficEnabled) {
    if (car.length) tomtom += s.stationsToCompare + discoveries; // station drives + drive the whole way
    if (rideshareLast) tomtom += rideshareStations + MAX_EXIT_LOOKUPS;
    if (rideshareLast && s.firstLegs.includes('CAR_PARKING')) tomtom += rideshareStations; // park & rideshare
  }
  return { tomtom, transitous };
}

const MAX_OPTIONS = 15;

export async function planTrip(search: TripRequest, opts: PlanOptions): Promise<PlanResult> {
  // Pin "now" to the whole minute, so this search's queries (and a repeat of it shortly after)
  // ask the same questions and can be answered from the server's cache.
  const req: TripRequest = { ...search, time: search.time ?? new Date(Math.floor(Date.now() / 60_000) * 60_000) };
  const usage: SearchUsage = { tomtom: 0, transitous: 0, cached: 0 };
  const notes: string[] = [];
  const driver = makeDriver({ ...opts, usage });
  const discoveries = new Map<string, Promise<PlanResponse | null>>();
  const reachable = new Map<string, Promise<boolean>>();
  const exitRides = new Map<string, Promise<Drive>>();
  let lastMile: Promise<LastMile | undefined> | undefined;
  const ctx: PlanContext = {
    ...opts,
    usage,
    transitousSlot: makeLimiter(TRANSITOUS_CONCURRENCY),
    notes,
    driver,
    stats: { tooShort: 0 },
    discovery(combo, mode) {
      let pending = discoveries.get(mode);
      if (!pending) {
        // It asks for a walking last leg, so it can't find anything if no station is in walking range.
        pending = ctx
          .reaches('WALK', req.maxLastLegMin, 'destination')
          .then((walkable) =>
            walkable
              ? planQuery(ctx, {
                  ...baseParams({ ...combo, lastLeg: 'WALK' }),
                  preTransitModes: mode,
                  maxPreTransitTime: req.maxFirstLegMin * 60,
                })
              : null,
          )
          .catch((err) => {
            rethrowIfFatal(err, opts.signal);
            return null;
          });
        discoveries.set(mode, pending);
      }
      return pending;
    },
    lastMile: () => (lastMile ??= prepareRideshareLastMile(req, driver, notes, opts.signal)),
    reaches(mode, minutes, end) {
      const km = reachKm(mode, minutes);
      if (km === null) return Promise.resolve(true);
      const key = `${end}:${mode}:${minutes}`;
      let pending = reachable.get(key);
      if (!pending) {
        const place = end === 'start' ? req.from : req.to;
        // Station tiles are cached and don't count toward any limit, unlike the plan queries this saves.
        pending = stationsNear(place, km, motisTransitModes(req.transit)).then(
          (stations) => canReachStation(stations, place, mode, minutes),
          (err) => {
            rethrowIfFatal(err, opts.signal);
            return true;
          },
        );
        reachable.set(key, pending);
      }
      return pending;
    },
    skipped(mode, minutes, end) {
      notes.push(`No stations within a ${minutes}-minute ${REACH_WORDS[mode]} of the ${end}, so those trips were skipped.`);
    },
    exitRide(place, departure) {
      // One lookup per station is plenty: traffic barely changes between nearby departures.
      const key = place.parentId ?? place.stopId ?? fmtLatLon(place);
      let pending = exitRides.get(key);
      if (!pending) {
        if (exitRides.size >= MAX_EXIT_LOOKUPS) return Promise.resolve(null);
        pending = driver.route(place, req.to, departure);
        exitRides.set(key, pending);
      }
      return pending;
    },
  };

  const combos: LegCombo[] = req.firstLegs.flatMap((firstLeg) => req.lastLegs.map((lastLeg) => ({ ...req, firstLeg, lastLeg })));
  const [results, parkAndRideshare] = await Promise.all([
    mapLimit(combos, 2, (combo) => (isCarFirst(combo.firstLeg) ? planCarFirst(combo, ctx) : planStreetFirst(combo, ctx))),
    req.firstLegs.includes('CAR_PARKING') && req.lastLegs.includes('RIDESHARE') ? planParkAndRideshare(req, ctx) : undefined,
  ]);

  let candidates = results.flatMap((r) => r.options);
  if (parkAndRideshare) {
    const before = candidates.length;
    candidates = candidates.filter((o) => !(o.id.startsWith('parkride:CAR_PARKING:') && slowerThanParkAndRideshare(o, parkAndRideshare)));
    const hidden = before - candidates.length;
    if (hidden) {
      notes.push(
        `Hid ${hidden} transit option${hidden > 1 ? 's' : ''} slower than parking at ${parkAndRideshare.station?.name ?? 'a station'} and taking a rideshare from there, with no shorter rideshare to show for it.`,
      );
    }
  }
  const all = sortOptions(dropDominated(candidates, req.arriveBy), req.arriveBy);
  const options = all.slice(0, MAX_OPTIONS);
  // No-transit alternatives, for comparison.
  const direct = [
    ...new Map(results.flatMap((r) => r.direct).map((o) => [o.id, o])).values(),
    ...(parkAndRideshare ? [parkAndRideshare] : []),
  ];

  if (driver.failed && usesCar(req)) notes.push(driver.note);
  if (ctx.stats.tooShort) {
    const n = ctx.stats.tooShort;
    notes.push(`Hid ${n} option${n > 1 ? 's' : ''} riding fewer than ${req.minTransitStops} stops on transit (see Limits).`);
  }
  if (all.length > MAX_OPTIONS) notes.push(`Showing the ${MAX_OPTIONS} best of ${all.length} options.`);
  if (!all.length && candidates.length === results.flatMap((r) => r.options).length) {
    notes.push('No transit connections found. Try more transit modes or a longer first/last leg.');
  }
  return { options, direct, notes: [...new Set(notes)], usage };
}

const usesCar = (req: TripRequest) => req.firstLegs.some(isCarFirst) || req.lastLegs.includes('RIDESHARE');

interface ComboResult {
  options: TripOption[];
  direct: TripOption[];
}

async function planStreetFirst(req: LegCombo, ctx: PlanContext): Promise<ComboResult> {
  ctx.onProgress?.('Planning…');
  const [startOk, endOk] = await Promise.all([
    ctx.reaches(req.firstLeg, req.maxFirstLegMin, 'start'),
    ctx.reaches(req.lastLeg, req.maxLastLegMin, 'destination'),
  ]);
  // Without transit the query can still find a walk or ride the whole way, if the trip is short.
  if (!startOk) ctx.skipped(req.firstLeg, req.maxFirstLegMin, 'start');
  if (!endOk) ctx.skipped(req.lastLeg, req.maxLastLegMin, 'destination');
  const directKm = reachKm(req.firstLeg, DIRECT_MAX_MIN) ?? 0;
  if (!(startOk && endOk) && haversineKm(req.from, req.to) > directKm) return { options: [], direct: [] };
  const lastMile = req.lastLeg === 'RIDESHARE' ? await ctx.lastMile() : undefined;
  if (req.lastLeg === 'RIDESHARE' && !lastMile) return { options: [], direct: [] };
  let res: PlanResponse;
  let tooShort: boolean;
  try {
    ({ plan: res, tooShort } = await planTransit(
      ctx,
      req,
      {
        ...baseParams(req),
        preTransitModes: req.firstLeg,
        maxPreTransitTime: req.maxFirstLegMin * 60,
        directModes: req.firstLeg,
      },
      lastMile ? { toOffsets: lastMile.offsets } : undefined,
    ));
  } catch (err) {
    rethrowIfFatal(err, ctx.signal);
    ctx.notes.push(`Couldn’t plan ${req.firstLeg.toLowerCase()} → ${req.lastLeg.toLowerCase()} trips (${(err as Error).message}).`);
    return { options: [], direct: [] };
  }
  if (lastMile) res = { ...res, itineraries: (await preferEarlyExits(ctx, req, realLastMile(res.itineraries, lastMile), lastMile)).kept };
  const prefix = `transit:${req.firstLeg}:${req.lastLeg}`;
  if (tooShort) ctx.stats.tooShort++;
  else if (!res.itineraries.length) {
    ctx.notes.push(
      `No ${req.firstLeg.toLowerCase()} → transit → ${req.lastLeg.toLowerCase()} trips within your limits; try a longer first or last leg, or more transit modes.`,
    );
  }
  return {
    options: sortOptions(
      res.itineraries.map((it, i) => itineraryOption(req, it, `${prefix}:${i}`, lastMile)),
      req.arriveBy,
    ).slice(0, 8),
    direct: res.direct.slice(0, 1).map((it) => itineraryOption(req, it, `direct:${req.firstLeg}`)),
  };
}

async function planCarFirst(req: LegCombo, ctx: PlanContext): Promise<ComboResult> {
  const { trafficEnabled, signal, onProgress, driver } = ctx;
  const base = baseParams(req);
  const maxKm = maxDriveKm(req.maxFirstLegMin);
  const anchor = req.time ?? new Date();

  // Departure times ignore the rideshare pickup wait so all car modes share the same lookups.
  const departureFor = (estimatedTripSec: number) => (req.arriveBy ? addSec(anchor, -estimatedTripSec) : anchor);
  const directCar = async () => [
    directCarOption(req, await driver.route(req.from, req.to, departureFor(estimateDrive(req.from, req.to).seconds))),
  ];

  onProgress?.('Finding stations…');
  if (!(await ctx.reaches(req.lastLeg, req.maxLastLegMin, 'destination'))) {
    ctx.skipped(req.lastLeg, req.maxLastLegMin, 'destination');
    return { options: [], direct: await directCar() };
  }
  const [discovery, nearby, lastMile] = await Promise.all([
    // Transitous has no rideshare mode; a drop-off has the same shape.
    ctx.discovery(req, req.firstLeg === 'RIDESHARE' ? 'CAR_DROPOFF' : req.firstLeg),
    stationsNear(req.from, maxKm, motisTransitModes(req.transit), (tile) =>
      inCorridor(req.from, req.to, tileCenter(tile), 2 * tileHalfDiagonalKm(tile)),
    ).catch((err) => {
      rethrowIfFatal(err, signal);
      ctx.notes.push('Could not load the station list; only Transitous’s own pick is shown.');
      return [] as MotisPlace[];
    }),
    req.lastLeg === 'RIDESHARE' ? ctx.lastMile() : Promise.resolve(undefined),
  ]);
  const direct = await directCar();
  if (req.lastLeg === 'RIDESHARE' && !lastMile) return { options: [], direct };

  // With a rideshare last leg, a station already within rideshare range of the destination is
  // somewhere to park and rideshare from (shown for comparison), not somewhere to start transit,
  // and a station the rideshare picks up from can't also be a start. Leaving them out before
  // choosing leaves room for stations nearer home.
  const scale = lastMile ? rideScale(req, lastMile) : 1;
  const pickups = new Set(lastMile?.offsets.map((o) => o.stopId));
  const usable = (station: LatLon, stopId?: string) =>
    !lastMile || (!pickups.has(stopId ?? '') && estimateDrive(station, req.to).seconds * scale > req.maxLastLegMin * 60);
  const discovered = (discovery ? discoveryCandidates(discovery, req.from, req.to) : []).filter((c) => usable(c.station, c.stopId));
  const nearbyPicks = pickCandidates(
    nearby.filter((s) => usable(s, s.stopId)),
    discovered,
    req.from,
    req.to,
    maxKm,
    req.stationsToCompare,
  );
  if (!nearbyPicks.length) {
    ctx.notes.push(
      lastMile && nearby.length
        ? 'Every station within reach is already a short rideshare from the destination, so no transit-then-rideshare trips were planned.'
        : `No stations found within about ${req.maxFirstLegMin} minutes’ drive for the selected transit modes.`,
    );
    return { options: [], direct };
  }

  onProgress?.(trafficEnabled ? `Checking traffic to ${nearbyPicks.length} stations…` : 'Estimating drive times…');
  const allDrives = await Promise.all(nearbyPicks.map((c) => driver.route(req.from, c.park, departureFor(c.estimateSec))));
  const { keep, relaxed } = withinLimit(allDrives, req.maxFirstLegMin * 60, 2);
  if (relaxed) ctx.notes.push(`No station is within ${req.maxFirstLegMin} min by car right now; showing the closest.`);
  const candidates = keep.map((i) => nearbyPicks[i]);
  const drives = keep.map((i) => allDrives[i]);

  let pool = candidates.map((_, i) => i);

  onProgress?.(`Planning transit from ${pool.length} stations…`);
  const bufferSec = firstLegBufferSec(req);
  const offsetSec = (i: number) => drives[i].seconds + bufferSec + candidates[i].walkSec;
  // What Transitous sees on top of the real first leg: a rideshare's cost, as for the last leg.
  const weightSec = (i: number) => (req.firstLeg === 'RIDESHARE' && !req.arriveBy ? Math.round(drives[i].seconds * RIDESHARE_COST_FACTOR) : 0);
  // One query covers every station: Transitous searches from all of them at once, each weighted
  // by its drive. If the answers use fewer than MIN_COMPARED_STATIONS stations, ask once more
  // without the ones already covered, so there's a comparison.
  const found = new Map<number, TripOption>();
  for (let round = 0; round < 2 && pool.length; round++) {
    let result: Awaited<ReturnType<typeof planTransit>>;
    try {
      result = await planTransit(
        ctx,
        req,
        base,
        {
          fromOffsets: pool.map((i) => ({ stopId: candidates[i].stopId, duration: offsetSec(i) + weightSec(i), mode: 'CAR' as const })),
          toOffsets: lastMile?.offsets,
        },
        'boarding',
      );
    } catch (err) {
      rethrowIfFatal(err, signal);
      break;
    }
    if (result.tooShort) ctx.stats.tooShort++;
    const stations = pool.map((i) => candidates[i]);
    // Back to real times: the first leg without its weight, the rideshare at its real length.
    const real = groupByBoarding(result.plan.itineraries, stations);
    const unweighted = [...real].flatMap(([j, group]) => group.map((it) => startLater(it, weightSec(pool[j]))));
    const { kept: its, dropped } = lastMile
      ? await preferEarlyExits(ctx, req, realLastMile(unweighted, lastMile), lastMile)
      : { kept: unweighted, dropped: [] };
    for (const [j, group] of groupByBoarding(its, stations)) {
      const i = pool[j];
      const option = buildParkRideOption(req, candidates[i], drives[i], offsetSec(i), { ...result.plan, itineraries: group }, lastMile);
      if (option) found.set(i, option);
    }
    // Stations already answered, or whose trips were too short or not worth it, won't give anything new.
    const used = new Set([...groupByBoarding([...result.short, ...dropped], stations).keys()].map((j) => pool[j]));
    const next = pool.filter((i) => !found.has(i) && !used.has(i));
    if (found.size >= MIN_COMPARED_STATIONS || next.length === pool.length) break;
    pool = next;
  }
  return { options: [...found.values()], direct };
}

/**
 * The best "park near the destination and rideshare the rest" option. Like driving the whole
 * way it's a no-transit comparison, so the max-drive limit doesn't apply.
 */
async function planParkAndRideshare(req: TripRequest, ctx: PlanContext): Promise<TripOption | undefined> {
  const lastMile = await ctx.lastMile();
  if (!lastMile) return undefined;
  const anchor = req.time ?? new Date();
  const options = await Promise.all(
    lastMile.candidates.map(async (hub, i) => {
      const ride = lastMile.drives[i];
      const departure = req.arriveBy
        ? addSec(anchor, -(estimateDrive(req.from, hub.station).seconds + lastMile.waitSec + ride.seconds))
        : anchor;
      const drive = await ctx.driver.route(req.from, hub.station, departure);
      return buildParkAndRideshareOption(req, hub, drive, ride);
    }),
  );
  return sortOptions(options, req.arriveBy)[0];
}
