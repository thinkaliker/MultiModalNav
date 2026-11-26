// Parking near transit stations, from OpenStreetMap through the Overpass API, so "drive & park"
// can prefer stations with free public parking. Pure functions; the endpoint is api/parking.ts.

export type ParkingStatus = 'free' | 'paid' | 'none' | 'unknown';

export interface ParkingLot {
  name?: string;
  lat: number;
  lon: number;
  distanceM: number;
  fee?: string;
  access?: string;
  parkRide: boolean;
}

export interface ParkingInfo {
  /**
   * free: a public lot that's free (or an official park & ride lot); paid: parking that charges;
   * none: only customer or private lots; unknown: nothing tagged well enough to tell.
   */
  status: ParkingStatus;
  /** The lot behind the status: the closest one that qualifies. */
  lot?: ParkingLot;
}

export interface Point {
  lat: number;
  lon: number;
}

export interface OverpassElement {
  type: string;
  lat?: number;
  lon?: number;
  center?: Point;
  tags?: Record<string, string>;
}

/** How far from a station's map position a lot still counts as its parking. */
export const PARKING_RADIUS_M = 300;

// Access values that rule out leaving a car all day for transit.
const NOT_PUBLIC = new Set(['private', 'customers', 'no', 'delivery', 'permit', 'residents', 'employees', 'students', 'destination']);

function distanceM(a: Point, b: Point): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** Parking lots within `radiusM` of `station`, closest first. */
export function lotsNear(station: Point, elements: OverpassElement[], radiusM = PARKING_RADIUS_M): ParkingLot[] {
  return elements
    .flatMap((e) => {
      const p = e.center ?? (e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : undefined);
      if (!p || e.tags?.amenity !== 'parking') return [];
      const d = distanceM(station, p);
      if (d > radiusM) return [];
      const parkRide = !!e.tags.park_ride && e.tags.park_ride !== 'no';
      return [{ name: e.tags.name, lat: p.lat, lon: p.lon, distanceM: Math.round(d), fee: e.tags.fee, access: e.tags.access, parkRide }];
    })
    .sort((a, b) => a.distanceM - b.distanceM);
}

const isPublic = (lot: ParkingLot) =>
  lot.parkRide || !lot.access || !lot.access.split(';').some((v) => NOT_PUBLIC.has(v.trim()));

export function classifyParking(station: Point, elements: OverpassElement[], radiusM = PARKING_RADIUS_M): ParkingInfo {
  const lots = lotsNear(station, elements, radiusM);
  const free = lots.find((l) => isPublic(l) && (l.fee === 'no' || (l.parkRide && l.fee !== 'yes')));
  if (free) return { status: 'free', lot: free };
  // "fee" can also hold opening-hours-style conditions; anything but "no" means paying sometimes.
  const charges = (l: ParkingLot) => l.fee !== undefined && l.fee !== 'no';
  const paid = lots.find((l) => isPublic(l) && charges(l)) ?? lots.find(charges);
  if (paid) return { status: 'paid', lot: paid };
  if (lots.length && !lots.some(isPublic)) return { status: 'none' };
  return { status: 'unknown', lot: lots.find(isPublic) };
}

/** One Overpass query for the parking around all `stations`. */
export function overpassQuery(stations: Point[], radiusM = PARKING_RADIUS_M): string {
  const around = stations.map((s) => `nwr[amenity=parking](around:${radiusM},${s.lat.toFixed(5)},${s.lon.toFixed(5)});`).join('');
  return `[out:json][timeout:15];(${around});out center tags;`;
}
