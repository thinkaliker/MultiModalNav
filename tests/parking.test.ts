import { afterEach, describe, expect, it, vi } from 'vitest';
import { COOLDOWN_SEC, onRequestPost, OVERPASS_URL, parseStations, type ParkingEnv as Env } from '../functions/api/parking';
import { classifyParking, overpassQuery, type OverpassElement } from '../functions/_lib/parking';
import { sqliteDb } from './sqlite';

const lot = (lat: number, lon: number, tags: Record<string, string> = {}): OverpassElement => ({
  type: 'way',
  center: { lat, lon },
  tags: { amenity: 'parking', ...tags },
});

// Tags as mapped in OpenStreetMap around two Blue Line stations in San Diego.
const nobelDrive = { lat: 32.8669, lon: -117.2304 };
const nobelLots = [
  lot(32.8669, -117.2308, { access: 'customers', fee: 'no', parking: 'surface' }),
  lot(32.8664, -117.2285, { access: 'private', fee: 'no', name: 'San Diego California Temple parking lot', park_ride: 'no' }),
  lot(32.8688, -117.2280),
  lot(32.8676, -117.2307, { access: 'yes', fee: 'no', parking: 'surface' }),
];
const utc = { lat: 32.8692, lon: -117.214 };
const utcLots = [
  lot(32.8697, -117.2122, { access: 'customers', fee: 'yes', parking: 'multi-storey', name: 'Westfield UTC' }),
  lot(32.8701, -117.2151, { access: 'customers', fee: 'yes', parking: 'multi-storey' }),
];

describe('classifyParking', () => {
  it('finds the free public lot by Nobel Drive among customer and private ones', () => {
    const info = classifyParking(nobelDrive, nobelLots);
    expect(info.status).toBe('free');
    expect(info.lot).toMatchObject({ access: 'yes', fee: 'no', parkRide: false });
    expect(info.lot!.distanceM).toBeGreaterThan(50);
    expect(info.lot!.distanceM).toBeLessThan(120);
  });

  it('calls UTC paid: only charging customer garages', () => {
    expect(classifyParking(utc, utcLots)).toMatchObject({ status: 'paid', lot: { fee: 'yes', access: 'customers' } });
  });

  it('counts park & ride lots as free unless they charge', () => {
    expect(classifyParking(utc, [lot(32.8695, -117.2141, { park_ride: 'yes' })]).status).toBe('free');
    expect(classifyParking(utc, [lot(32.8695, -117.2141, { park_ride: 'yes', fee: 'yes' })]).status).toBe('paid');
  });

  it('tells "only private parking" apart from "nothing mapped"', () => {
    expect(classifyParking(utc, [lot(32.8695, -117.2141, { access: 'private' })])).toEqual({ status: 'none' });
    expect(classifyParking(utc, []).status).toBe('unknown');
    expect(classifyParking(utc, [lot(32.8695, -117.2141)])).toMatchObject({ status: 'unknown', lot: { lat: 32.8695 } });
  });

  it('ignores lots out of range, whichever station they belong to', () => {
    expect(classifyParking(utc, nobelLots).status).toBe('unknown');
  });
});

describe('overpassQuery', () => {
  it('asks for parking around every station in one query', () => {
    expect(overpassQuery([nobelDrive, utc])).toBe(
      '[out:json][timeout:15];(nwr[amenity=parking](around:300,32.86690,-117.23040);nwr[amenity=parking](around:300,32.86920,-117.21400););out center tags;',
    );
  });
});

describe('parseStations', () => {
  it('rounds positions and rejects bad input', () => {
    expect(parseStations({ stations: [{ lat: 32.866905, lon: -117.230430 }] })).toEqual([{ lat: 32.8669, lon: -117.2304 }]);
    expect(parseStations({ stations: [] })).toBeNull();
    expect(parseStations({ stations: [{ lat: '32', lon: -117 }] })).toBeNull();
    expect(parseStations({ stations: [{ lat: 95, lon: -117 }] })).toBeNull();
    expect(parseStations({ stations: Array(25).fill(utc) })).toBeNull();
    expect(parseStations(null)).toBeNull();
  });
});

describe('POST /api/parking', () => {
  afterEach(() => vi.unstubAllGlobals());

  const call = async (env: Env, stations: unknown[]) => {
    const pending: Promise<unknown>[] = [];
    const res = await onRequestPost({
      request: new Request('https://app.test/api/parking', { method: 'POST', body: JSON.stringify({ stations }) }),
      env,
      waitUntil: (p) => pending.push(p),
    });
    await Promise.all(pending);
    return { res, body: (await res.json()) as { parking: unknown[]; incomplete?: boolean } };
  };

  it('asks Overpass once by POST with a contact, then answers from the cache', async () => {
    const overpass = vi.fn(async () => Response.json({ elements: [...nobelLots, ...utcLots] }));
    vi.stubGlobal('fetch', overpass);
    const env = { USAGE_DB: sqliteDb(), MULTIMODALNAV_CONTACT: 'ops@example.com' } as Env;

    const first = await call(env, [nobelDrive, utc]);
    expect(first.body.parking.map((p) => (p as { status: string }).status)).toEqual(['free', 'paid']);
    expect(first.res.headers.get('X-Cache')).toBe('MISS');
    expect(overpass).toHaveBeenCalledTimes(1);
    const [url, init] = overpass.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(OVERPASS_URL);
    expect(init.method).toBe('POST');
    expect(init.headers['User-Agent']).toMatch(/^MultiModalNav\/.* \(\+https:\/\/github\.com\/thinkaliker\/MultiModalNav; ops@example\.com\)$/);
    expect(new URLSearchParams(init.body as string).get('data')).toBe(overpassQuery([nobelDrive, utc]));

    const again = await call(env, [utc]);
    expect(again.res.headers.get('X-Cache')).toBe('HIT');
    expect(again.body.parking).toEqual([first.body.parking[1]]);
    expect(overpass).toHaveBeenCalledTimes(1);
  });

  it('answers "unknown for now" when Overpass fails, and leaves it alone for a while', async () => {
    const overpass = vi.fn(async () => new Response('busy', { status: 504 }));
    vi.stubGlobal('fetch', overpass);
    const env = { USAGE_DB: sqliteDb() } as Env;

    expect((await call(env, [utc])).body).toEqual({ parking: [null], incomplete: true });
    expect((await call(env, [nobelDrive])).body).toEqual({ parking: [null], incomplete: true });
    expect(overpass).toHaveBeenCalledTimes(1);
    expect(COOLDOWN_SEC).toBeGreaterThanOrEqual(60);
  });

  it('does not cache a query Overpass cut short', async () => {
    const overpass = vi.fn(async () => Response.json({ elements: [], remark: 'runtime error: Query timed out' }));
    vi.stubGlobal('fetch', overpass);
    expect((await call({ USAGE_DB: sqliteDb() } as Env, [utc])).body.incomplete).toBe(true);
  });

  it('rejects a malformed request', async () => {
    const { res } = await call({} as Env, [{ lat: 'x' }]);
    expect(res.status).toBe(400);
  });
});
