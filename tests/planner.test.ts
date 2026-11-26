import { describe, expect, it } from 'vitest';
import {
  withinLimit,
  buildParkAndRideshareOption,
  buildParkRideOption,
  estimateCost,
  displayLegs,
  firstLegBufferSec,
  discoveryCandidates,
  driveFromTomTom,
  driveTiming,
  estimateDrive,
  pickCandidates,
  scoreStation,
  offsetsAvoiding,
  transitStops,
  canReachStation,
  reachKm,
  exitPlace,
  groupByBoarding,
  tripCost,
  TRANSFER_PENALTY_SEC,
  earlyExits,
  exitEarly,
  dropDominated,
  revisitsStation,
  slowerThanParkAndRideshare,
} from '../src/lib/planner';
import type { LegCombo, MotisItinerary, MotisLeg, MotisPlace, PlanResponse, TripOption, TripSettings } from '../src/lib/types';

const torrance = { lat: 33.8358, lon: -118.3406, name: 'Home' };
const santaMonica = { lat: 34.0195, lon: -118.4912, name: 'Work' };
const expoBundy = { lat: 34.0315, lon: -118.4529 };

function leg(partial: Partial<MotisLeg> & Pick<MotisLeg, 'mode' | 'from' | 'to' | 'startTime' | 'endTime'>): MotisLeg {
  return {
    scheduledStartTime: partial.startTime,
    scheduledEndTime: partial.endTime,
    realTime: false,
    duration: (Date.parse(partial.endTime) - Date.parse(partial.startTime)) / 1000,
    legGeometry: { points: '', precision: 6, length: 0 },
    ...partial,
  };
}

const place = (name: string, p: { lat: number; lon: number }, extra: Partial<MotisPlace> = {}): MotisPlace => ({
  name,
  ...p,
  ...extra,
});

const request: LegCombo = {
  from: torrance,
  to: santaMonica,
  time: new Date('2026-12-01T16:00:00Z'),
  arriveBy: false,
  firstLeg: 'CAR_PARKING',
  firstLegs: ['CAR_PARKING'],
  transit: ['LIGHT_RAIL'],
  lastLeg: 'WALK',
  lastLegs: ['WALK'],
  maxFirstLegMin: 30,
  maxLastLegMin: 15,
  parkBufferMin: 5,
  rideshareWaitMin: 6,
  stationsToCompare: 6,
  minTransitStops: 3,
};

describe('scoreStation', () => {
  it('accepts a station on the way', () => {
    expect(scoreStation(torrance, santaMonica, expoBundy, 33)).toBeGreaterThan(0);
  });

  it('rejects stations beyond the drive radius', () => {
    expect(scoreStation(torrance, santaMonica, expoBundy, 10)).toBeNull();
  });

  it('rejects stations in the wrong direction', () => {
    const longBeach = { lat: 33.768, lon: -118.1893 };
    expect(scoreStation(torrance, santaMonica, longBeach, 40)).toBeNull();
  });
});

describe('discoveryCandidates', () => {
  it('extracts the boarding station, parking spot and walk time', () => {
    const parking = { lat: 34.0301, lon: -118.4545 };
    const it: MotisItinerary = {
      duration: 3060,
      startTime: '2026-12-01T16:02:00Z',
      endTime: '2026-12-01T16:53:00Z',
      transfers: 0,
      legs: [
        leg({ mode: 'CAR', from: place('START', torrance), to: place('', parking), startTime: '2026-12-01T16:02:00Z', endTime: '2026-12-01T16:24:00Z' }),
        leg({ mode: 'WALK', from: place('', parking), to: place('Expo / Bundy Station', expoBundy), startTime: '2026-12-01T16:24:00Z', endTime: '2026-12-01T16:31:00Z' }),
        leg({
          mode: 'TRAM',
          from: place('Expo / Bundy Station', expoBundy, { stopId: 'rail_80136', parentId: 'rail_80136S' }),
          to: place('Downtown Santa Monica Station', santaMonica),
          startTime: '2026-12-01T16:31:00Z',
          endTime: '2026-12-01T16:39:00Z',
        }),
      ],
    };
    const [c] = discoveryCandidates({ itineraries: [it, it], direct: [] }, torrance, santaMonica);
    expect(c.stopId).toBe('rail_80136S');
    expect(c.park).toEqual(parking);
    expect(c.walkSec).toBe(420);
    expect(discoveryCandidates({ itineraries: [it, it], direct: [] }, torrance, santaMonica)).toHaveLength(1);
  });
});

describe('pickCandidates', () => {
  const stations: MotisPlace[] = [
    place('Expo / Bundy Station', expoBundy, { stopId: 'bundy' }),
    place('Expo / Sepulveda Station', { lat: 34.0354, lon: -118.4249 }, { stopId: 'sepulveda' }),
    place('Redondo Beach Station', { lat: 33.8945, lon: -118.3693 }, { stopId: 'redondo' }),
    place('Long Beach Station', { lat: 33.768, lon: -118.1893 }, { stopId: 'longbeach' }),
  ];

  it('puts Transitous picks first, then ranks the rest and drops off-corridor stations', () => {
    const discovered = discoveryCandidates({ itineraries: [], direct: [] }, torrance, santaMonica);
    const picked = pickCandidates(stations, discovered, torrance, santaMonica, 33, 10);
    expect(picked.map((c) => c.stopId)).not.toContain('longbeach');
    expect(picked.length).toBe(3);
  });

  it('spreads picks along the corridor instead of clustering near the destination', () => {
    const picked = pickCandidates(stations, [], torrance, santaMonica, 33, 2);
    expect(picked.map((c) => c.stopId)).toContain('redondo');
  });

  it('skips stations right next to the destination', () => {
    const pier = place('Downtown Santa Monica Station', { lat: 34.0141, lon: -118.4913 }, { stopId: 'dtsm' });
    expect(pickCandidates([pier], [], torrance, santaMonica, 33, 5)).toHaveLength(0);
  });

  it('respects the requested count and skips duplicates', () => {
    const dupe = { ...stations[0], stopId: 'bundy-2', lat: expoBundy.lat + 0.001 };
    const picked = pickCandidates([...stations, dupe], [], torrance, santaMonica, 33, 2);
    expect(picked).toHaveLength(2);
    expect(new Set(picked.map((c) => c.name)).size).toBe(2);
  });
});

describe('driveTiming', () => {
  const now = Date.parse('2026-12-01T15:00:00Z');

  it('uses "now" for past or imminent departures', () => {
    expect(driveTiming(new Date(now - 600_000), now)).toEqual({ departAt: 'now' });
    expect(driveTiming(new Date(now + 30_000), now)).toEqual({ departAt: 'now' });
  });

  it('formats future departures for TomTom', () => {
    expect(driveTiming(new Date('2026-12-01T16:00:00Z'), now)).toEqual({ departAt: '2026-12-01T16:00:00+00:00' });
  });
});

describe('drive helpers', () => {
  it('reads a TomTom response', () => {
    const drive = driveFromTomTom({
      routes: [
        {
          summary: {
            lengthInMeters: 26000,
            travelTimeInSeconds: 2700,
            trafficDelayInSeconds: 900,
            departureTime: '2026-12-01T08:00:00-08:00',
            arrivalTime: '2026-12-01T08:45:00-08:00',
          },
          legs: [{ points: [{ latitude: 33.8358, longitude: -118.3406 }, { latitude: 34.0315, longitude: -118.4529 }] }],
        },
      ],
    });
    expect(drive).toMatchObject({ seconds: 2700, delaySec: 900, distanceM: 26000, estimated: false });
    expect(drive.coords[0]).toEqual([-118.3406, 33.8358]);
  });

  it('estimates a drive without traffic data', () => {
    const drive = estimateDrive(torrance, expoBundy);
    expect(drive.estimated).toBe(true);
    expect(drive.seconds).toBeGreaterThan(1800);
    expect(drive.seconds).toBeLessThan(3600);
  });
});

describe('buildParkRideOption', () => {
  const candidate = {
    key: 'bundy',
    stopId: 'bundy',
    name: 'Expo / Bundy Station',
    station: expoBundy,
    park: { lat: 34.0301, lon: -118.4545 },
    walkSec: 120,
    source: 'discovery' as const,
    estimateSec: 3000,
  };
  const drive = { seconds: 2700, delaySec: 900, distanceM: 26000, coords: [] as [number, number][], estimated: false };
  const offsetSec = 2700 + 300 + 120;

  const itinerary = (start: string, depart: string, arrive: string): MotisItinerary => ({
    duration: (Date.parse(arrive) - Date.parse(start)) / 1000,
    startTime: start,
    endTime: arrive,
    transfers: 0,
    legs: [
      leg({ mode: 'CAR', from: place('START', torrance), to: place('Expo / Bundy Station', expoBundy), startTime: start, endTime: new Date(Date.parse(start) + offsetSec * 1000).toISOString() }),
      leg({ mode: 'TRAM', from: place('Expo / Bundy Station', expoBundy, { tz: 'America/Los_Angeles' }), to: place('END', santaMonica), startTime: depart, endTime: arrive, routeShortName: 'E', routeColor: 'FDB913' }),
    ],
  });

  it('picks the earliest arrival and lists the other departures', () => {
    const plan: PlanResponse = {
      direct: [],
      itineraries: [
        itinerary('2026-12-01T16:10:00Z', '2026-12-01T17:02:00Z', '2026-12-01T17:20:00Z'),
        itinerary('2026-12-01T16:02:00Z', '2026-12-01T16:54:00Z', '2026-12-01T17:12:00Z'),
      ],
    };
    const option = buildParkRideOption(request, candidate, drive, offsetSec, plan)!;
    expect(option.endTime).toBe('2026-12-01T17:12:00Z');
    expect(option.alternatives).toEqual([{ startTime: '2026-12-01T16:10:00Z', endTime: '2026-12-01T17:20:00Z' }]);
    expect(option.legs.map((l) => l.mode)).toEqual(['CAR', 'PARK', 'TRAM']);
    expect(option.legs[1].durationSec).toBe(420);
    expect(option.legs[2].to.name).toBe('Work');
    expect(option.legs[2].color).toBe('#FDB913');
    expect(option.traffic).toEqual({ label: 'Drive', driveSec: 2700, delaySec: 900, estimated: false });
  });

  it('returns null when no connection was found', () => {
    expect(buildParkRideOption(request, candidate, drive, offsetSec, { itineraries: [], direct: [] })).toBeNull();
  });
});

describe('inCorridor', () => {
  it('keeps points between origin and destination and drops ones behind the origin', async () => {
    const { inCorridor } = await import('../src/lib/planner');
    expect(inCorridor(torrance, santaMonica, expoBundy)).toBe(true);
    expect(inCorridor(torrance, santaMonica, { lat: 33.6, lon: -118.1 })).toBe(false);
  });
});

describe('rideshare', () => {
  const bundyStation = { lat: 34.0315, lon: -118.4529 };
  const candidate = {
    key: 'bundy',
    stopId: 'bundy',
    name: 'Expo / Bundy Station',
    station: bundyStation,
    park: bundyStation,
    walkSec: 0,
    source: 'nearby' as const,
    estimateSec: 3000,
  };
  const drive = { seconds: 1800, delaySec: 300, distanceM: 20000, coords: [] as [number, number][], estimated: false };

  it('adds the pickup wait to a rideshare first leg', () => {
    const rideshareReq = { ...request, firstLeg: 'RIDESHARE' as const };
    expect(firstLegBufferSec(rideshareReq)).toBe(6 * 60 + 60);
    expect(firstLegBufferSec(request)).toBe(5 * 60);

    const offsetSec = drive.seconds + firstLegBufferSec(rideshareReq);
    const start = '2026-12-01T16:00:00Z';
    const atStation = new Date(Date.parse(start) + offsetSec * 1000).toISOString();
    const plan: PlanResponse = {
      direct: [],
      itineraries: [
        {
          duration: 3600,
          startTime: start,
          endTime: '2026-12-01T17:00:00Z',
          transfers: 0,
          legs: [
            leg({ mode: 'CAR', from: place('START', torrance), to: place('Expo / Bundy Station', bundyStation), startTime: start, endTime: atStation }),
            leg({ mode: 'TRAM', from: place('Expo / Bundy Station', bundyStation), to: place('END', santaMonica), startTime: '2026-12-01T16:45:00Z', endTime: '2026-12-01T17:00:00Z', routeShortName: 'E' }),
          ],
        },
      ],
    };
    const option = buildParkRideOption(rideshareReq, candidate, drive, offsetSec, plan)!;
    expect(option.title).toBe('Rideshare to Expo / Bundy Station');
    expect(option.legs.map((l) => [l.mode, l.durationSec])).toEqual([
      ['WAIT', 360],
      ['RIDESHARE', 1800],
      ['TRAM', 900],
    ]);
    expect(option.traffic?.label).toBe('Ride');
  });

  it('turns the injected last-mile leg into a wait and a ride', () => {
    const lastMile = {
      candidates: [candidate],
      drives: [drive],
      waitSec: 360,
      offsets: [{ stopId: 'bundy', duration: 60 + 360 + 1800, mode: 'CAR' as const }],
    };
    const legs = displayLegs(
      [
        leg({ mode: 'TRAM', from: place('Redondo Beach Station', torrance), to: place('Expo / Bundy Station', bundyStation), startTime: '2026-12-01T16:00:00Z', endTime: '2026-12-01T16:50:00Z', routeShortName: 'K' }),
        leg({
          mode: 'CAR',
          from: place('Expo / Bundy Station', bundyStation, { stopId: 'bundy-platform', parentId: 'bundy' }),
          to: place('END', santaMonica),
          startTime: '2026-12-01T16:50:00Z',
          endTime: '2026-12-01T17:27:00Z',
        }),
      ],
      { ...request, lastLegs: ['RIDESHARE'] },
      lastMile,
    );
    expect(legs.map((l) => [l.mode, l.durationSec])).toEqual([
      ['TRAM', 3000],
      ['WAIT', 420],
      ['RIDESHARE', 1800],
    ]);
    expect(legs[2].to.name).toBe('Work');
    expect(legs[2].trafficDelaySec).toBe(300);
  });

  it('leaves trips without an injected last mile alone', () => {
    const legs = displayLegs(
      [leg({ mode: 'WALK', from: place('Station', bundyStation), to: place('END', santaMonica), startTime: '2026-12-01T16:50:00Z', endTime: '2026-12-01T17:00:00Z' })],
      request,
    );
    expect(legs.map((l) => l.mode)).toEqual(['WALK']);
  });
});

describe('withinLimit', () => {
  const d = (seconds: number) => ({ seconds, delaySec: 0, distanceM: 0, coords: [] as [number, number][], estimated: false });

  it('keeps only drives within the limit', () => {
    expect(withinLimit([d(600), d(2400), d(1200)], 1800)).toEqual({ keep: [0, 2], relaxed: false });
  });

  it('falls back to the shortest drives when none fit', () => {
    expect(withinLimit([d(4000), d(2400), d(3000)], 1800, 2)).toEqual({ keep: [1, 2], relaxed: true });
  });
});

describe('estimateCost', () => {
  const base: TripSettings = {
    firstLegs: ['CAR_PARKING'],
    transit: ['LIGHT_RAIL'],
    lastLegs: ['WALK'],
    maxFirstLegMin: 30,
    maxLastLegMin: 15,
    parkBufferMin: 5,
    rideshareWaitMin: 6,
    stationsToCompare: 6,
    minTransitStops: 3,
  };

  it('matches a plain park-and-ride search', () => {
    // discovery + one query for all stations + one for a comparison, and a retry for each;
    // 6 station drives + drive the whole way
    expect(estimateCost(base, true)).toEqual({ tomtom: 7, transitous: 5 });
    expect(estimateCost(base, false)).toEqual({ tomtom: 0, transitous: 5 });
    expect(estimateCost({ ...base, minTransitStops: 1 }, true)).toEqual({ tomtom: 7, transitous: 3 });
  });

  it('grows with each first/last combination', () => {
    const combos = { ...base, firstLegs: ['CAR_PARKING', 'BIKE'], lastLegs: ['WALK', 'RIDESHARE'] } satisfies TripSettings;
    // Transitous: 1 discovery + 1 car mode x 2 last legs x 2 queries + 1 street mode x 2 last legs
    // TomTom: 6 + 1, then 6 rideshare stations + 4 early-exit rides, then 6 park-and-rideshare drives
    expect(estimateCost({ ...combos, minTransitStops: 1 }, true)).toEqual({ tomtom: 23, transitous: 7 });
    // A minimum ride allows a retry per car query, plus the bike query with a rideshare last leg.
    expect(estimateCost(combos, true)).toEqual({ tomtom: 23, transitous: 12 });
  });
});

describe('minimum transit stops', () => {
  const stop = (name: string, lat: number, extra: Partial<MotisPlace> = {}) =>
    place(name, { lat, lon: -117.15 }, { stopId: name, ...extra });
  const ride = (stops: number, exit: MotisPlace): MotisItinerary => {
    const board = stop('board', 32.6);
    const between = Array.from({ length: stops - 1 }, (_, i) => stop(`mid${i}`, 32.61 + i * 0.01));
    return {
      duration: 1800,
      startTime: '2026-12-01T16:00:00Z',
      endTime: '2026-12-01T16:30:00Z',
      transfers: 0,
      legs: [
        leg({ mode: 'CAR', from: place('START', torrance), to: board, startTime: '2026-12-01T16:00:00Z', endTime: '2026-12-01T16:10:00Z' }),
        leg({
          mode: 'TRAM',
          from: board,
          to: exit,
          intermediateStops: between,
          startTime: '2026-12-01T16:10:00Z',
          endTime: '2026-12-01T16:20:00Z',
        }),
        leg({ mode: 'CAR', from: exit, to: place('END', santaMonica), startTime: '2026-12-01T16:20:00Z', endTime: '2026-12-01T16:30:00Z' }),
      ],
    };
  };

  it('counts stops ridden on transit only', () => {
    expect(transitStops(ride(1, stop('next', 32.61)))).toBe(1);
    expect(transitStops(ride(4, stop('far', 32.7)))).toBe(4);
  });

  it('drops the rideshare stations that too-short trips got off at', () => {
    const offsets = [
      { stopId: 'next-parent', duration: 600, mode: 'CAR' as const },
      { stopId: 'other', duration: 900, mode: 'CAR' as const },
      { stopId: 'far', duration: 300, mode: 'CAR' as const },
    ];
    // Transitous reports the child stop; the offset was sent for its parent station.
    const its = [ride(1, stop('next', 32.61, { parentId: 'next-parent' })), ride(2, stop('other', 32.62))];
    expect(offsetsAvoiding(its.map(exitPlace), offsets).map((o) => o.stopId)).toEqual(['far']);
  });
});

describe('merged station queries', () => {
  const station = (key: string, lat: number) => ({
    key,
    stopId: key,
    name: key,
    station: { lat, lon: -117.15 },
    park: { lat, lon: -117.15 },
    walkSec: 0,
    source: 'nearby' as const,
    estimateSec: 0,
  });
  const trip = (board: MotisPlace): MotisItinerary => ({
    duration: 600,
    startTime: '2026-12-01T16:00:00Z',
    endTime: '2026-12-01T16:10:00Z',
    transfers: 0,
    legs: [leg({ mode: 'CAR', from: place('START', torrance), to: board, startTime: '2026-12-01T16:00:00Z', endTime: '2026-12-01T16:10:00Z' })],
  });

  it('groups trips by the station they board at, matching child stops to parents', () => {
    const stations = [station('north', 32.9), station('south', 32.7)];
    const groups = groupByBoarding(
      [
        trip(place('North platform 1', { lat: 32.9001, lon: -117.15 }, { stopId: 'north-1', parentId: 'north' })),
        trip(place('South', { lat: 32.7, lon: -117.15 }, { stopId: 'south' })),
        trip(place('Unknown, near north', { lat: 32.901, lon: -117.15 }, { stopId: 'other' })),
        trip(place('Far away', { lat: 33.5, lon: -117.15 }, { stopId: 'far' })),
      ],
      stations,
    );
    expect([...groups].map(([i, its]) => [stations[i].key, its.length])).toEqual([
      ['north', 2],
      ['south', 1],
    ]);
  });

  it('ranks a transfer as worth five minutes', () => {
    const arrive = (minute: number) => `2026-12-01T16:${String(minute).padStart(2, '0')}:00Z`;
    // Two minutes faster with a transfer loses to the direct ride; ten minutes faster wins.
    expect(tripCost(false, arrive(0), arrive(30), 1)).toBeGreaterThan(tripCost(false, arrive(0), arrive(32), 0));
    expect(tripCost(false, arrive(0), arrive(30), 1)).toBeLessThan(tripCost(false, arrive(0), arrive(40), 0));
    // Arrive-by prefers the later departure.
    expect(tripCost(true, arrive(10), arrive(40), 0)).toBeLessThan(tripCost(true, arrive(5), arrive(40), 0));
    expect(TRANSFER_PENALTY_SEC).toBe(300);
  });
});

describe('leaving transit early', () => {
  const t = (minute: number) => `2026-12-01T16:${String(minute).padStart(2, '0')}:00Z`;
  const stop = (name: string, lat: number) => place(name, { lat, lon: -117.15 }, { stopId: name });
  const stops = (n: number, lat: number) => Array.from({ length: n }, (_, i) => stop(`s${lat}-${i}`, lat + i * 0.001));
  // Drive, Blue for 4 stops, walk across the platform, Green for 3 stops, then the injected rideshare.
  const blueGreen: MotisItinerary = {
    duration: 3600,
    startTime: t(0),
    endTime: '2026-12-01T17:00:00Z',
    transfers: 1,
    legs: [
      leg({ mode: 'CAR', from: place('START', torrance), to: stop('balboa', 32.8), startTime: t(0), endTime: t(10) }),
      leg({ mode: 'TRAM', routeShortName: 'Blue', from: stop('balboa', 32.8), to: stop('oldtown', 32.75), intermediateStops: stops(3, 32.78), startTime: t(12), endTime: t(22) }),
      leg({ mode: 'WALK', from: stop('oldtown', 32.75), to: stop('oldtown', 32.75), startTime: t(22), endTime: t(24) }),
      leg({ mode: 'TRAM', routeShortName: 'Green', from: stop('oldtown', 32.75), to: stop('riovista', 32.77), intermediateStops: stops(2, 32.76), startTime: t(30), endTime: t(40) }),
      leg({ mode: 'CAR', from: stop('riovista', 32.77), to: place('END', santaMonica), startTime: t(40), endTime: '2026-12-01T17:00:00Z' }),
    ],
  };

  it('offers an exit at each line change, with the stops ridden by then', () => {
    expect(earlyExits(blueGreen)).toEqual([{ legIndex: 1, stops: 4 }]);
  });

  it('cuts the trip at the change and rides from there', () => {
    const cut = exitEarly(blueGreen, 1, 15 * 60);
    expect(cut.legs.map((l) => l.mode)).toEqual(['CAR', 'TRAM', 'CAR']);
    expect(cut.legs[2].from.name).toBe('oldtown');
    expect(Date.parse(cut.legs[2].startTime)).toBe(Date.parse(t(22)));
    expect(Date.parse(cut.endTime)).toBe(Date.parse(t(37)));
    expect(cut.transfers).toBe(0);
    expect(cut.duration).toBe(37 * 60);
    // Arriving 23 minutes sooner with one line fewer is clearly better.
    expect(tripCost(false, cut.startTime, cut.endTime, cut.transfers)).toBeLessThan(
      tripCost(false, blueGreen.startTime, blueGreen.endTime, blueGreen.transfers),
    );
  });
});

describe('buildParkAndRideshareOption', () => {
  it('chains drive, parking, pickup wait and ride with no transit', () => {
    const hub = {
      key: 'bundy',
      stopId: 'bundy',
      name: 'Expo / Bundy Station',
      station: { lat: 34.0315, lon: -118.4529 },
      park: { lat: 34.0315, lon: -118.4529 },
      walkSec: 0,
      source: 'nearby' as const,
      estimateSec: 2000,
    };
    const d = (seconds: number) => ({ seconds, delaySec: 0, distanceM: 1000, coords: [] as [number, number][], estimated: false });
    const option = buildParkAndRideshareOption(request, hub, d(1800), d(600));
    expect(option.title).toBe('Park at Expo / Bundy Station, rideshare the rest');
    expect(option.transfers).toBe(0);
    expect(option.legs.map((l) => [l.mode, l.durationSec])).toEqual([
      ['CAR', 1800],
      ['PARK', 5 * 60 + 60],
      ['WAIT', 6 * 60],
      ['RIDESHARE', 600],
    ]);
    expect(option.startTime).toBe('2026-12-01T16:00:00.000Z');
    expect(option.durationSec).toBe(1800 + 360 + 360 + 600);

    const arriveBy = buildParkAndRideshareOption({ ...request, arriveBy: true }, hub, d(1800), d(600));
    expect(arriveBy.endTime).toBe('2026-12-01T16:00:00.000Z');
  });
});

describe('canReachStation', () => {
  const zoo = { lat: 32.7353, lon: -117.149 };
  const cityCollege = { lat: 32.7166, lon: -117.1544 }; // about 2.1 km away

  it('rules out a walk that is too short to reach any station', () => {
    expect(canReachStation([cityCollege], zoo, 'WALK', 15)).toBe(false);
    expect(canReachStation([cityCollege], zoo, 'WALK', 25)).toBe(true);
  });

  it('gives bikes a longer reach and never rules out car legs', () => {
    expect(canReachStation([cityCollege], zoo, 'BIKE', 10)).toBe(true);
    expect(canReachStation([], zoo, 'RIDESHARE', 15)).toBe(true);
    expect(reachKm('CAR_PARKING', 30)).toBeNull();
  });
});

describe('dropDominated', () => {
  const option = (id: string, start: string, end: string, transfers = 0) =>
    ({ id, startTime: `2026-12-01T${start}:00Z`, endTime: `2026-12-01T${end}:00Z`, transfers }) as unknown as TripOption;

  it('drops an option that leaves at about the same time and arrives clearly later', () => {
    const kept = dropDominated(
      [
        option('best', '16:26', '17:12'),
        option('worse', '16:27', '17:32', 1), // a minute later, 25 minutes behind with the transfer
        option('later', '16:45', '17:45'), // leaves much later: a real alternative
        option('close', '16:26', '17:24'), // 12 minutes behind: kept for the comparison
      ],
      false,
    );
    expect(kept.map((o) => o.id)).toEqual(['best', 'later', 'close']);
  });

  it('works from the arrival side for "arrive by"', () => {
    const kept = dropDominated([option('late', '16:40', '17:20'), option('early', '16:20', '17:19')], true);
    // Leaving 20 minutes earlier for the same arrival is clearly worse.
    expect(kept.map((o) => o.id)).toEqual(['late']);
  });
});

describe('revisitsStation', () => {
  const t = (minute: number) => `2026-12-01T18:${String(minute).padStart(2, '0')}:00Z`;
  const stop = (name: string, lat: number, parentId?: string) =>
    place(name, { lat, lon: -117.1 }, { stopId: `${name}-1`, parentId: parentId ?? name });
  const tram = (from: MotisPlace, to: MotisPlace, start: number, end: number, via: MotisPlace[] = []) =>
    leg({ mode: 'TRAM', from, to, intermediateStops: via, startTime: t(start), endTime: t(end) });
  const trip = (...legs: MotisLeg[]): MotisItinerary => ({ duration: 0, startTime: t(0), endTime: t(30), transfers: legs.length - 1, legs });

  it('catches riding one stop out and back to the same station', () => {
    // Fenton Parkway → Rio Vista, change, Rio Vista → Fenton Parkway (a different platform).
    const loop = trip(tram(stop('fenton', 32.77), stop('riovista', 32.774), 0, 3), tram(stop('riovista', 32.774), stop('fenton-b', 32.77, 'fenton'), 8, 11));
    expect(revisitsStation(loop)).toBe(true);
  });

  it('allows ordinary transfers', () => {
    const ok = trip(
      tram(stop('balboa', 32.8), stop('oldtown', 32.75), 0, 10, [stop('clairemont', 32.79), stop('tecolote', 32.77)]),
      leg({ mode: 'WALK', from: stop('oldtown', 32.75), to: stop('oldtown-b', 32.75, 'oldtown'), startTime: t(10), endTime: t(12) }),
      tram(stop('oldtown-b', 32.75, 'oldtown'), stop('riovista', 32.774), 14, 25, [stop('fashionvalley', 32.76)]),
    );
    expect(revisitsStation(ok)).toBe(false);
  });
});

describe('slowerThanParkAndRideshare', () => {
  const option = (durationMin: number, rideMin: number, driveMin = 21) =>
    ({
      durationSec: durationMin * 60,
      traffic: { label: 'Drive', driveSec: driveMin * 60, delaySec: 0, estimated: false },
      legs: rideMin ? [{ mode: 'TRAM', durationSec: 600 }, { mode: 'RIDESHARE', durationSec: rideMin * 60 }] : [{ mode: 'TRAM', durationSec: 600 }],
    }) as unknown as TripOption;
  // Park at Mission San Diego (22 min drive), rideshare 11 min.
  const parkAndRideshare = option(40, 11, 22);

  it('hides transit that only adds time before the same drive and rideshare', () => {
    expect(slowerThanParkAndRideshare(option(75, 11), parkAndRideshare)).toBe(true);
  });

  it('keeps transit that saves rideshare or driving, or is about as fast', () => {
    expect(slowerThanParkAndRideshare(option(75, 3), parkAndRideshare)).toBe(false);
    expect(slowerThanParkAndRideshare(option(50, 11), parkAndRideshare)).toBe(false);
    expect(slowerThanParkAndRideshare(option(75, 0), parkAndRideshare)).toBe(false);
    // Parking downtown means a 32-minute drive instead of 21: that's what the trolley saves.
    expect(slowerThanParkAndRideshare(option(75, 6), option(40, 5, 32))).toBe(false);
  });
});

describe('pickCandidates closest', () => {
  it('can take the stations nearest the start first', () => {
    const near = (name: string, lat: number): MotisPlace => ({ name, stopId: name, lat, lon: -118.3406 });
    // Seen from the destination's side: Santa Monica to Torrance, stations spread south.
    const stations = [near('a', 34.0), near('b', 33.98), near('c', 33.9), near('d', 33.95)];
    const picked = pickCandidates(stations, [], santaMonica, torrance, 30, 2, 2);
    expect(picked.map((c) => c.name)).toEqual(['a', 'b']);
  });
});

describe('pickCandidates spacing', () => {
  it('skips a station right next to one already picked on the same kind of line', () => {
    const stop = (name: string, lat: number, modes: string[]): MotisPlace => ({ name, stopId: name, lat, lon: -118.3406, modes });
    const stations = [stop('utc', 33.9, ['TRAM']), stop('executive', 33.905, ['TRAM']), stop('coaster', 33.902, ['REGIONAL_RAIL']), stop('nobel', 33.89, ['TRAM'])];
    const picked = pickCandidates(stations, [], torrance, santaMonica, 40, 3);
    expect(picked.map((c) => c.name).sort()).toEqual(['coaster', 'nobel', 'utc'].sort());
  });
});
