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
} from '../src/lib/planner';
import type { LegCombo, MotisItinerary, MotisLeg, MotisPlace, PlanResponse, TripSettings } from '../src/lib/types';

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
  };

  it('matches a plain park-and-ride search', () => {
    // discovery + 6 stations; 6 station drives + drive the whole way
    expect(estimateCost(base, true)).toEqual({ tomtom: 7, transitous: 7 });
    expect(estimateCost(base, false)).toEqual({ tomtom: 0, transitous: 7 });
  });

  it('grows with each first/last combination', () => {
    const cost = estimateCost({ ...base, firstLegs: ['CAR_PARKING', 'BIKE'], lastLegs: ['WALK', 'RIDESHARE'] }, true);
    // Transitous: 1 discovery + 1 car mode x 2 last legs x 6 stations + 1 street mode x 2 last legs
    // TomTom: 6 + 1, then 4 rideshare stations, then 4 park-and-rideshare drives
    expect(cost).toEqual({ tomtom: 15, transitous: 15 });
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
