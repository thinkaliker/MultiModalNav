import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIRROR_HEADER, onRequestPost, parseStations, type ParkingEnv as Env } from '../functions/api/parking';
import { failed, MIRRORS } from '../functions/_lib/overpass';
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

describe('Overpass servers', () => {
  it('uses the regional server only where it has data', () => {
    const dresel = MIRRORS.find((m) => m.id === 'dresel')!;
    expect(dresel.endpoint([nobelDrive, utc], {})).toBe('https://ovp.dresel.systems/api-na/interpreter');
    expect(dresel.endpoint([{ lat: 48.137, lon: 11.575 }], {})).toBe('https://ovp.dresel.systems/api/interpreter');
    expect(dresel.endpoint([{ lat: 35.68, lon: 139.77 }], {})).toBeNull();
  });

  it('uses the keyed servers only with a key, given bare or as the full URL', () => {
    const nextgis = MIRRORS.find((m) => m.id === 'nextgis')!;
    const fairway = MIRRORS.find((m) => m.id === 'fairwaymapper')!;
    expect(nextgis.endpoint([utc], {})).toBeNull();
    expect(nextgis.endpoint([utc], { NEXTGIS_OVERPASS_KEY: ' abc-123 ' })).toBe('https://overpass.nextgis.com/abc-123/api/interpreter');
    expect(fairway.endpoint([utc], { FAIRWAYMAPPER_OVERPASS_KEY: 'k_9' })).toBe('https://api.fairwaymapper.com/k/k_9/api/interpreter');
    expect(nextgis.endpoint([utc], { NEXTGIS_OVERPASS_KEY: 'https://overpass.nextgis.com/xyz/api/interpreter' })).toBe(
      'https://overpass.nextgis.com/xyz/api/interpreter',
    );
    expect(nextgis.endpoint([utc], { NEXTGIS_OVERPASS_KEY: '../oops' })).toBeNull();
  });

  it('sends the contact to Private.coffee only', () => {
    expect(MIRRORS.filter((m) => m.contact).map((m) => m.id)).toEqual(['private.coffee']);
  });

  it('pauses a failing server for longer each time, up to an hour', () => {
    const t = 1_000_000;
    const once = failed(null, t);
    expect(once).toEqual({ failures: 1, until: t + 300_000 });
    expect(failed(once, t).until).toBe(t + 600_000);
    expect(failed({ failures: 9, until: 0 }, t).until).toBe(t + 3_600_000);
  });
});

describe('POST /api/parking', () => {
  afterEach(() => vi.unstubAllGlobals());

  type Init = RequestInit & { headers: Record<string, string> };
  /** A fetch stub answering per server: elements, or an HTTP status for a failure. */
  const servers = (answers: Record<string, OverpassElement[] | number>) =>
    vi.fn(async (url: string, _init: Init) => {
      const id = Object.keys(answers).find((host) => url.includes(host));
      const answer = id === undefined ? 503 : answers[id];
      return typeof answer === 'number' ? new Response('busy', { status: answer }) : Response.json({ elements: answer });
    });
  const hosts = (fetcher: ReturnType<typeof servers>) => fetcher.mock.calls.map(([url]) => new URL(url).host);

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

  it('asks Private.coffee by POST with the contact, then answers from the cache', async () => {
    const fetcher = servers({ 'private.coffee': [...nobelLots, ...utcLots] });
    vi.stubGlobal('fetch', fetcher);
    const env = { USAGE_DB: sqliteDb(), MULTIMODALNAV_CONTACT: 'ops@example.com' } as Env;

    const first = await call(env, [nobelDrive, utc]);
    expect(first.body.parking.map((p) => (p as { status: string }).status)).toEqual(['free', 'paid']);
    expect(first.res.headers.get('X-Cache')).toBe('MISS');
    expect(first.res.headers.get(MIRROR_HEADER)).toBe('private.coffee');
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://overpass.private.coffee/api/interpreter');
    expect(init.method).toBe('POST');
    expect(init.headers['User-Agent']).toMatch(/^MultiModalNav\/.* \(\+https:\/\/github\.com\/thinkaliker\/MultiModalNav; ops@example\.com\)$/);
    expect(new URLSearchParams(init.body as string).get('data')).toBe(overpassQuery([nobelDrive, utc]));

    const again = await call(env, [utc]);
    expect(again.res.headers.get('X-Cache')).toBe('HIT');
    expect(again.body.parking).toEqual([first.body.parking[1]]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('moves on to the next server without the contact, and skips a failed one for a while', async () => {
    const fetcher = servers({ 'private.coffee': 504, 'dresel.systems': [...nobelLots, ...utcLots] });
    vi.stubGlobal('fetch', fetcher);
    const env = { USAGE_DB: sqliteDb(), MULTIMODALNAV_CONTACT: 'ops@example.com' } as Env;

    const first = await call(env, [nobelDrive]);
    expect(first.body.parking).toEqual([expect.objectContaining({ status: 'free' })]);
    expect(first.res.headers.get(MIRROR_HEADER)).toBe('dresel');
    expect(hosts(fetcher)).toEqual(['overpass.private.coffee', 'ovp.dresel.systems']);
    expect(fetcher.mock.calls[1][1].headers['User-Agent']).not.toContain('ops@example.com');

    await call(env, [utc]);
    expect(hosts(fetcher).slice(2)).toEqual(['ovp.dresel.systems']);
  });

  it('answers "unknown for now" when every server fails, then leaves them alone', async () => {
    const fetcher = servers({});
    vi.stubGlobal('fetch', fetcher);
    const env = { USAGE_DB: sqliteDb() } as Env;

    expect((await call(env, [utc])).body).toEqual({ parking: [null], incomplete: true });
    expect(hosts(fetcher)).toEqual(['overpass.private.coffee', 'ovp.dresel.systems', 'overpass-api.de']);
    expect((await call(env, [nobelDrive])).body).toEqual({ parking: [null], incomplete: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('tries the keyed servers before overpass-api.de, without logging their keys', async () => {
    const fetcher = servers({ 'nextgis.com': 401, 'fairwaymapper.com': [...nobelLots] });
    vi.stubGlobal('fetch', fetcher);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = { USAGE_DB: sqliteDb(), NEXTGIS_OVERPASS_KEY: 'secret-n', FAIRWAYMAPPER_OVERPASS_KEY: 'secret-f' } as Env;

    const { res, body } = await call(env, [nobelDrive]);
    expect(body.parking).toEqual([expect.objectContaining({ status: 'free' })]);
    expect(res.headers.get(MIRROR_HEADER)).toBe('fairwaymapper');
    expect(hosts(fetcher)).toEqual(['overpass.private.coffee', 'ovp.dresel.systems', 'overpass.nextgis.com', 'api.fairwaymapper.com']);
    expect(warn).toHaveBeenCalledWith('Overpass nextgis: key rejected (HTTP 401)');
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret-/);
    warn.mockRestore();
  });

  it('does not cache a query a server cut short', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ elements: [], remark: 'runtime error: Query timed out' })));
    expect((await call({ USAGE_DB: sqliteDb() } as Env, [utc])).body.incomplete).toBe(true);
  });

  it('rejects a malformed request', async () => {
    const { res } = await call({} as Env, [{ lat: 'x' }]);
    expect(res.status).toBe(400);
  });
});
