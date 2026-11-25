import { api, AuthError, type DriveTiming, type PlanParams } from './api';
import { fmtLatLon, haversineKm, tileCenter, tileHalfDiagonalKm } from './geo';
import { isCarFirst, modeColor, modeTextColor, motisTransitModes, STREET_MODES } from './modes';
import { decodePolyline } from './polyline';
import { stationsNear } from './stations';
import type {
  DisplayLeg,
  LatLon,
  MotisItinerary,
  MotisLeg,
  MotisPlace,
  NamedPlace,
  PlanResponse,
  TomTomRouteResponse,
  TripOption,
  TripRequest,
} from './types';

// Rough speeds used only to pre-rank candidate stations and as a fallback without traffic data.
const DRIVE_KMH = 40;
const TRANSIT_KMH = 30;
const ROAD_FACTOR = 1.3;
const TRANSIT_FACTOR = 1.25;
const DROPOFF_BUFFER_SEC = 60;
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
  direct?: TripOption;
  notes: string[];
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

/** TomTom wants an RFC 3339 time in the future, or "now". */
export function driveTiming(time: Date | null, arriveBy: boolean, estimatedTripSec: number, now = Date.now()): DriveTiming {
  if (!time) return { departAt: 'now' };
  const departure = arriveBy ? new Date(time.getTime() - estimatedTripSec * 1000) : time;
  if (departure.getTime() <= now + 60_000) return { departAt: 'now' };
  return { departAt: departure.toISOString().replace(/\.\d{3}Z$/, '+00:00') };
}

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

const ms = (iso: string) => Date.parse(iso);

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

export function buildParkRideOption(
  req: TripRequest,
  candidate: Candidate,
  drive: Drive,
  offsetSec: number,
  plan: PlanResponse,
): TripOption | null {
  const its = sortItineraries(
    plan.itineraries.filter((it) => it.legs.length > 1 && it.legs[0].mode === 'CAR'),
    req.arriveBy,
  );
  const best = its[0];
  if (!best) return null;

  const [carLeg, ...rest] = best.legs;
  const driveEnd = new Date(ms(carLeg.startTime) + drive.seconds * 1000).toISOString();
  const dropoff = req.firstLeg === 'CAR_DROPOFF';
  const legs: DisplayLeg[] = [
    {
      mode: 'CAR',
      label: `${dropoff ? 'Get dropped off at' : 'Drive to'} ${candidate.name}`,
      startTime: carLeg.startTime,
      endTime: driveEnd,
      durationSec: drive.seconds,
      from: req.from,
      to: { name: candidate.name, ...candidate.park },
      tz: rest[0]?.from.tz,
      coords: drive.coords,
      color: modeColor('CAR'),
      textColor: '#ffffff',
      dashed: false,
      realTime: false,
      distanceM: drive.distanceM,
      trafficDelaySec: drive.delaySec,
      trafficEstimated: drive.estimated,
    },
  ];
  if (!dropoff) {
    const parkToStationKm = haversineKm(candidate.park, candidate.station);
    legs.push({
      mode: 'PARK',
      label: 'Park and walk to the platform',
      startTime: driveEnd,
      endTime: carLeg.endTime,
      durationSec: offsetSec - drive.seconds,
      from: { name: 'Parking', ...candidate.park },
      to: { name: candidate.name, ...candidate.station },
      tz: rest[0]?.from.tz,
      coords:
        parkToStationKm > 0.02
          ? [
              [candidate.park.lon, candidate.park.lat],
              [candidate.station.lon, candidate.station.lat],
            ]
          : [],
      color: modeColor('PARK'),
      textColor: '#ffffff',
      dashed: true,
      realTime: false,
    });
  }
  legs.push(...rest.map((l) => toDisplayLeg(l, req)));

  return {
    id: `parkride:${candidate.key}`,
    kind: 'parkride',
    title: `${dropoff ? 'Drop-off at' : 'Park at'} ${candidate.name}`,
    startTime: best.startTime,
    endTime: best.endTime,
    durationSec: best.duration,
    transfers: best.transfers,
    legs,
    station: { name: candidate.name, ...candidate.station },
    alternatives: alternativesOf(its),
    traffic: { driveSec: drive.seconds, delaySec: drive.delaySec, estimated: drive.estimated },
    realTime: legs.some((l) => l.realTime),
  };
}

export function itineraryOption(req: TripRequest, it: MotisItinerary, id: string): TripOption {
  const legs = it.legs.map((l) => toDisplayLeg(l, req));
  const board = it.legs.find((l) => !STREET_MODES.has(l.mode));
  return {
    id,
    kind: board ? 'transit' : 'direct',
    title: board ? `Board at ${placeName(board.from, req)}` : `${STREET_VERB[it.legs[0]?.mode] ?? 'Go'} the whole way`,
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

function directDriveOption(req: TripRequest, drive: Drive): TripOption {
  const anchor = req.time ?? new Date();
  const start = req.arriveBy ? new Date(anchor.getTime() - drive.seconds * 1000) : anchor;
  const end = new Date(start.getTime() + drive.seconds * 1000);
  return {
    id: 'direct:drive',
    kind: 'direct',
    title: 'Drive the whole way',
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    durationSec: drive.seconds,
    transfers: 0,
    legs: [
      {
        mode: 'CAR',
        label: `Drive to ${req.to.name}`,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        durationSec: drive.seconds,
        from: req.from,
        to: req.to,
        coords: drive.coords,
        color: modeColor('CAR'),
        textColor: '#ffffff',
        dashed: false,
        realTime: false,
        distanceM: drive.distanceM,
        trafficDelaySec: drive.delaySec,
        trafficEstimated: drive.estimated,
      },
    ],
    alternatives: [],
    traffic: { driveSec: drive.seconds, delaySec: drive.delaySec, estimated: drive.estimated },
    realTime: false,
  };
}

function baseParams(req: TripRequest): PlanParams {
  return {
    fromPlace: fmtLatLon(req.from),
    toPlace: fmtLatLon(req.to),
    time: (req.time ?? new Date()).toISOString(),
    arriveBy: req.arriveBy,
    transitModes: motisTransitModes(req.transit).join(','),
    postTransitModes: req.lastLeg,
    maxPostTransitTime: req.maxLastLegMin * 60,
  };
}

interface PlanOptions {
  trafficEnabled: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

function rethrowIfFatal(err: unknown, signal?: AbortSignal) {
  if (err instanceof AuthError || signal?.aborted) throw err;
}

export async function planTrip(req: TripRequest, opts: PlanOptions): Promise<PlanResult> {
  return isCarFirst(req.firstLeg) ? planCarFirst(req, opts) : planStreetFirst(req, opts);
}

async function planStreetFirst(req: TripRequest, { signal, onProgress }: PlanOptions): Promise<PlanResult> {
  onProgress?.('Planning…');
  const res = await api.plan(
    {
      ...baseParams(req),
      preTransitModes: req.firstLeg,
      maxPreTransitTime: req.maxFirstLegMin * 60,
      directModes: req.firstLeg,
    },
    signal,
  );
  const options = sortOptions(
    res.itineraries.map((it, i) => itineraryOption(req, it, `transit:${i}`)),
    req.arriveBy,
  ).slice(0, 8);
  const direct = res.direct[0] ? itineraryOption(req, res.direct[0], 'direct:street') : undefined;
  const notes = options.length ? [] : ['No transit connections found. Try more transit modes or a longer first/last leg.'];
  return { options, direct, notes };
}

async function planCarFirst(req: TripRequest, { trafficEnabled, signal, onProgress }: PlanOptions): Promise<PlanResult> {
  const notes: string[] = [];
  const base = baseParams(req);
  const maxKm = maxDriveKm(req.maxFirstLegMin);

  onProgress?.('Finding stations…');
  const [discovery, nearby] = await Promise.all([
    api
      .plan({ ...base, preTransitModes: req.firstLeg, maxPreTransitTime: req.maxFirstLegMin * 60 }, signal)
      .catch((err) => {
        rethrowIfFatal(err, signal);
        return null;
      }),
    stationsNear(req.from, maxKm, motisTransitModes(req.transit), (tile) =>
      inCorridor(req.from, req.to, tileCenter(tile), 2 * tileHalfDiagonalKm(tile)),
    ).catch((err) => {
      rethrowIfFatal(err, signal);
      notes.push('Could not load the station list; only Transitous’s own pick is shown.');
      return [] as MotisPlace[];
    }),
  ]);
  const discovered = discovery ? discoveryCandidates(discovery, req.from, req.to) : [];
  const candidates = pickCandidates(nearby, discovered, req.from, req.to, maxKm, req.stationsToCompare);
  if (!candidates.length) {
    notes.push(`No stations found within about ${req.maxFirstLegMin} minutes’ drive for the selected transit modes.`);
    return { options: [], notes };
  }

  onProgress?.(trafficEnabled ? `Checking traffic to ${candidates.length} stations…` : 'Estimating drive times…');
  let trafficFailed = !trafficEnabled;
  const drive = async (to: LatLon, estimatedTripSec: number): Promise<Drive> => {
    if (!trafficFailed) {
      try {
        const res = await api.trafficRoute(req.from, to, driveTiming(req.time, req.arriveBy, estimatedTripSec), signal);
        if (res.routes?.length) return driveFromTomTom(res);
      } catch (err) {
        rethrowIfFatal(err, signal);
        trafficFailed = true;
      }
    }
    return estimateDrive(req.from, to);
  };
  const [drives, directDrive] = await Promise.all([
    mapLimit(candidates, 4, (c) => drive(c.park, c.estimateSec)),
    drive(req.to, estimateDrive(req.from, req.to).seconds),
  ]);
  if (trafficFailed) {
    notes.push(
      trafficEnabled
        ? 'Traffic lookup failed for some stations; those drive times are estimates.'
        : 'Traffic is not configured (TOMTOM_API_KEY); drive times are rough estimates.',
    );
  }

  onProgress?.(`Planning transit from ${candidates.length} stations…`);
  const bufferSec = req.firstLeg === 'CAR_DROPOFF' ? DROPOFF_BUFFER_SEC : req.parkBufferMin * 60;
  const options = await mapLimit(candidates, 3, async (c, i) => {
    const offsetSec = drives[i].seconds + bufferSec + c.walkSec;
    try {
      const plan = await api.planWithOffsets(base, [{ stopId: c.stopId, duration: offsetSec, mode: 'CAR' }], signal);
      return buildParkRideOption(req, c, drives[i], offsetSec, plan);
    } catch (err) {
      rethrowIfFatal(err, signal);
      return null;
    }
  });

  const found = options.filter((o): o is TripOption => o !== null);
  if (found.length < candidates.length) {
    notes.push(`${candidates.length - found.length} of ${candidates.length} stations had no connection in the search window.`);
  }
  return { options: sortOptions(found, req.arriveBy), direct: directDriveOption(req, directDrive), notes };
}
