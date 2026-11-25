import { describe, expect, it } from 'vitest';
import {
  buildParkRideOption,
  discoveryCandidates,
  driveFromTomTom,
  driveTiming,
  estimateDrive,
  pickCandidates,
  scoreStation,
} from '../src/lib/planner';
import type { MotisItinerary, MotisLeg, MotisPlace, PlanResponse, TripRequest } from '../src/lib/types';

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

const request: TripRequest = {
  from: torrance,
  to: santaMonica,
  time: new Date('2026-12-01T16:00:00Z'),
  arriveBy: false,
  firstLeg: 'CAR_PARKING',
  transit: ['LIGHT_RAIL'],
  lastLeg: 'WALK',
  maxFirstLegMin: 30,
  maxLastLegMin: 15,
  parkBufferMin: 5,
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

  it('uses "now" for immediate departures', () => {
    expect(driveTiming(null, false, 0, now)).toEqual({ departAt: 'now' });
    expect(driveTiming(new Date(now + 30_000), false, 0, now)).toEqual({ departAt: 'now' });
  });

  it('formats future departures for TomTom', () => {
    expect(driveTiming(new Date('2026-12-01T16:00:00Z'), false, 0, now)).toEqual({ departAt: '2026-12-01T16:00:00+00:00' });
  });

  it('backs arrive-by times off by the estimated trip length', () => {
    expect(driveTiming(new Date('2026-12-01T17:00:00Z'), true, 3600, now)).toEqual({ departAt: '2026-12-01T16:00:00+00:00' });
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
    expect(option.traffic).toEqual({ driveSec: 2700, delaySec: 900, estimated: false });
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
