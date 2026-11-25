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
} from './types';

// Rough speeds used only to pre-rank candidate stations and as a fallback without traffic data.
const DRIVE_KMH = 40;
const TRANSIT_KMH = 30;
const ROAD_FACTOR = 1.3;
const TRANSIT_FACTOR = 1.25;
// Getting out of a car at the curb and walking to (or from) the platform.
const CURB_SEC = 60;
const MAX_RIDESHARE_STATIONS = 4;
const CORRIDOR_BANDS = 3;

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

/** Estimated door-to-door seconds via `station`, or null if it's out of range or off the corridor. */
export function scoreStation(from: LatLon, to: LatLon, station: LatLon, maxKm: number): number | null {
  if (haversineKm(from, station) > maxKm || !inCorridor(from, to, station)) return null;
  // Parking right next to the destination is just driving the whole way.
  if (haversineKm(station, to) < Math.max(1.5, 0.12 * haversineKm(from, to))) return null;
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
    if (!stopId || out.some((c) => c.key === stopId)) continue;
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
  const isDuplicate = (c: Candidate) =>
    picked.some((p) => p.key === c.key || (p.name === c.name && haversineKm(p.station, c.station) < 0.4));
  const take = (c: Candidate | undefined) => {
    if (c && picked.length < count && !isDuplicate(c)) picked.push(c);
  };
  discovered.forEach(take);
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

function rideshareLastLegs(leg: MotisLeg, req: TripRequest, lastMile: LastMile): DisplayLeg[] {
  const key = leg.from.parentId ?? leg.from.stopId;
  let index = lastMile.candidates.findIndex((c) => c.key === key || c.stopId === leg.from.stopId);
  if (index < 0) {
    // Fall back to the closest candidate if Transitous reports a child stop we didn't send.
    const dist = lastMile.candidates.map((c) => haversineKm(c.station, leg.from));
    index = dist.indexOf(Math.min(...dist));
  }
  const station = lastMile.candidates[index];
  const drive = lastMile.drives[index];
  const end = ms(leg.endTime);
  const rideStart = end - drive.seconds * 1000;
  const stationPlace: NamedPlace = { name: station.name, ...station.station };
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
  return legs.flatMap((leg, i) =>
    // Callers strip any first-mile car leg, so a trailing CAR leg here is always the injected one.
    lastMile && i === legs.length - 1 && leg.mode === 'CAR'
      ? rideshareLastLegs(leg, req, lastMile)
      : [toDisplayLeg(leg, req)],
  );
}

function sortItineraries(its: MotisItinerary[], arriveBy: boolean): MotisItinerary[] {
  return [...its].sort((a, b) =>
    arriveBy
      ? ms(b.startTime) - ms(a.startTime) || a.duration - b.duration
      : ms(a.endTime) - ms(b.endTime) || a.duration - b.duration,
  );
}

function sortOptions(options: TripOption[], arriveBy: boolean): TripOption[] {
  return [...options].sort((a, b) =>
    arriveBy
      ? ms(b.startTime) - ms(a.startTime) || a.durationSec - b.durationSec
      : ms(a.endTime) - ms(b.endTime) || a.durationSec - b.durationSec,
  );
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
  stats: { tried: number; missing: number };
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

/** Transitous plan queries, counted toward this search's usage. */
function planQuery(ctx: PlanContext, params: PlanParams, offsets?: Parameters<typeof api.planWithOffsets>[1]) {
  return ctx.transitousSlot(() => {
    ctx.usage.transitous++;
    return offsets ? api.planWithOffsets(params, offsets, ctx.signal) : api.plan(params, ctx.signal);
  });
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
      const res = await api.trafficRoute(from, to, timing, signal);
      usage.tomtom++;
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
  // Same ranking as for the first leg, seen from the destination's side.
  const candidates = pickCandidates(nearby, [], req.to, req.from, maxKm, Math.min(req.stationsToCompare, MAX_RIDESHARE_STATIONS));
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
  return {
    candidates: kept.map((k) => k.candidate),
    drives: kept.map((k) => k.drive),
    waitSec,
    offsets: kept.map(({ candidate, drive }) => ({
      stopId: candidate.stopId,
      duration: CURB_SEC + waitSec + drive.seconds,
      mode: 'CAR' as const,
    })),
  };
}

/** Upper-bound estimate of the upstream calls a search with these settings makes. */
export function estimateCost(s: TripSettings, trafficEnabled: boolean): SearchUsage {
  const car = s.firstLegs.filter(isCarFirst);
  const street = s.firstLegs.length - car.length;
  const discoveries = new Set(car.map((m) => (m === 'CAR_PARKING' ? 'CAR_PARKING' : 'CAR_DROPOFF'))).size;
  const rideshareLast = s.lastLegs.includes('RIDESHARE');
  const rideshareStations = Math.min(s.stationsToCompare, MAX_RIDESHARE_STATIONS);
  const transitous = discoveries + car.length * s.lastLegs.length * s.stationsToCompare + street * s.lastLegs.length;
  let tomtom = 0;
  if (trafficEnabled) {
    if (car.length) tomtom += s.stationsToCompare + discoveries; // station drives + drive the whole way
    if (rideshareLast) tomtom += rideshareStations;
    if (rideshareLast && s.firstLegs.includes('CAR_PARKING')) tomtom += rideshareStations; // park & rideshare
  }
  return { tomtom, transitous };
}

const MAX_OPTIONS = 15;

export async function planTrip(req: TripRequest, opts: PlanOptions): Promise<PlanResult> {
  const usage: SearchUsage = { tomtom: 0, transitous: 0 };
  const notes: string[] = [];
  const driver = makeDriver({ ...opts, usage });
  const discoveries = new Map<string, Promise<PlanResponse | null>>();
  let lastMile: Promise<LastMile | undefined> | undefined;
  const ctx: PlanContext = {
    ...opts,
    usage,
    transitousSlot: makeLimiter(TRANSITOUS_CONCURRENCY),
    notes,
    driver,
    stats: { tried: 0, missing: 0 },
    discovery(combo, mode) {
      let pending = discoveries.get(mode);
      if (!pending) {
        pending = planQuery(ctx, {
          ...baseParams({ ...combo, lastLeg: 'WALK' }),
          preTransitModes: mode,
          maxPreTransitTime: req.maxFirstLegMin * 60,
        }).catch((err) => {
          rethrowIfFatal(err, opts.signal);
          return null;
        });
        discoveries.set(mode, pending);
      }
      return pending;
    },
    lastMile: () => (lastMile ??= prepareRideshareLastMile(req, driver, notes, opts.signal)),
  };

  const combos: LegCombo[] = req.firstLegs.flatMap((firstLeg) => req.lastLegs.map((lastLeg) => ({ ...req, firstLeg, lastLeg })));
  const [results, parkAndRideshare] = await Promise.all([
    mapLimit(combos, 2, (combo) => (isCarFirst(combo.firstLeg) ? planCarFirst(combo, ctx) : planStreetFirst(combo, ctx))),
    req.firstLegs.includes('CAR_PARKING') && req.lastLegs.includes('RIDESHARE') ? planParkAndRideshare(req, ctx) : undefined,
  ]);

  const all = sortOptions(results.flatMap((r) => r.options), req.arriveBy);
  const options = all.slice(0, MAX_OPTIONS);
  // No-transit alternatives, for comparison.
  const direct = [
    ...new Map(results.flatMap((r) => r.direct).map((o) => [o.id, o])).values(),
    ...(parkAndRideshare ? [parkAndRideshare] : []),
  ];

  if (driver.failed && usesCar(req)) notes.push(driver.note);
  if (ctx.stats.missing) {
    notes.push(`${ctx.stats.missing} of ${ctx.stats.tried} station options had no connection in the search window.`);
  }
  if (all.length > MAX_OPTIONS) notes.push(`Showing the ${MAX_OPTIONS} best of ${all.length} options.`);
  if (!all.length) notes.push('No transit connections found. Try more transit modes or a longer first/last leg.');
  return { options, direct, notes: [...new Set(notes)], usage };
}

const usesCar = (req: TripRequest) => req.firstLegs.some(isCarFirst) || req.lastLegs.includes('RIDESHARE');

interface ComboResult {
  options: TripOption[];
  direct: TripOption[];
}

async function planStreetFirst(req: LegCombo, ctx: PlanContext): Promise<ComboResult> {
  ctx.onProgress?.('Planning…');
  const lastMile = req.lastLeg === 'RIDESHARE' ? await ctx.lastMile() : undefined;
  if (req.lastLeg === 'RIDESHARE' && !lastMile) return { options: [], direct: [] };
  let res: PlanResponse;
  try {
    res = await planQuery(
      ctx,
      {
        ...baseParams(req),
        preTransitModes: req.firstLeg,
        maxPreTransitTime: req.maxFirstLegMin * 60,
        directModes: req.firstLeg,
      },
      lastMile ? { toOffsets: lastMile.offsets } : undefined,
    );
  } catch (err) {
    rethrowIfFatal(err, ctx.signal);
    ctx.notes.push(`Couldn’t plan ${req.firstLeg.toLowerCase()} → ${req.lastLeg.toLowerCase()} trips (${(err as Error).message}).`);
    return { options: [], direct: [] };
  }
  const prefix = `transit:${req.firstLeg}:${req.lastLeg}`;
  if (!res.itineraries.length) {
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

  onProgress?.('Finding stations…');
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
  // Departure times ignore the rideshare pickup wait so all car modes share the same lookups.
  const departureFor = (estimatedTripSec: number) => (req.arriveBy ? addSec(anchor, -estimatedTripSec) : anchor);
  const directDrive = driver.route(req.from, req.to, departureFor(estimateDrive(req.from, req.to).seconds));
  const direct = [directCarOption(req, await directDrive)];
  if (req.lastLeg === 'RIDESHARE' && !lastMile) return { options: [], direct };

  const discovered = discovery ? discoveryCandidates(discovery, req.from, req.to) : [];
  const nearbyPicks = pickCandidates(nearby, discovered, req.from, req.to, maxKm, req.stationsToCompare);
  if (!nearbyPicks.length) {
    ctx.notes.push(`No stations found within about ${req.maxFirstLegMin} minutes’ drive for the selected transit modes.`);
    return { options: [], direct };
  }

  onProgress?.(trafficEnabled ? `Checking traffic to ${nearbyPicks.length} stations…` : 'Estimating drive times…');
  const allDrives = await Promise.all(nearbyPicks.map((c) => driver.route(req.from, c.park, departureFor(c.estimateSec))));
  const { keep, relaxed } = withinLimit(allDrives, req.maxFirstLegMin * 60, 2);
  if (relaxed) ctx.notes.push(`No station is within ${req.maxFirstLegMin} min by car right now; showing the closest.`);
  const candidates = keep.map((i) => nearbyPicks[i]);
  const drives = keep.map((i) => allDrives[i]);

  onProgress?.(`Planning transit from ${candidates.length} stations…`);
  const bufferSec = firstLegBufferSec(req);
  const options = await mapLimit(candidates, 3, async (c, i) => {
    const offsetSec = drives[i].seconds + bufferSec + c.walkSec;
    try {
      const plan = await planQuery(ctx, base, {
        fromOffsets: [{ stopId: c.stopId, duration: offsetSec, mode: 'CAR' }],
        toOffsets: lastMile?.offsets,
      });
      return buildParkRideOption(req, c, drives[i], offsetSec, plan, lastMile);
    } catch (err) {
      rethrowIfFatal(err, signal);
      return null;
    }
  });

  const found = options.filter((o): o is TripOption => o !== null);
  ctx.stats.tried += candidates.length;
  ctx.stats.missing += candidates.length - found.length;
  return { options: found, direct };
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
