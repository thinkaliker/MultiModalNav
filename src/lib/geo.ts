import type { LatLon } from './types';

const EARTH_RADIUS_KM = 6371;
const rad = (deg: number) => (deg * Math.PI) / 180;

export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export interface Tile {
  key: string;
  min: LatLon;
  max: LatLon;
}

/** Fixed-grid tiles covering a circle, so repeated searches hit the same cached tiles. */
export function tilesAround(center: LatLon, radiusKm: number, tileDeg = 0.25): Tile[] {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.max(Math.cos(rad(center.lat)), 0.1));
  const lat0 = Math.floor((center.lat - dLat) / tileDeg);
  const lat1 = Math.floor((center.lat + dLat) / tileDeg);
  const lon0 = Math.floor((center.lon - dLon) / tileDeg);
  const lon1 = Math.floor((center.lon + dLon) / tileDeg);
  const tiles: Tile[] = [];
  for (let y = lat0; y <= lat1; y++) {
    for (let x = lon0; x <= lon1; x++) {
      const min = { lat: round(y * tileDeg), lon: round(x * tileDeg) };
      const max = { lat: round((y + 1) * tileDeg), lon: round((x + 1) * tileDeg) };
      tiles.push({ key: `${tileDeg}:${y}:${x}`, min, max });
    }
  }
  return tiles;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export const tileCenter = (t: Tile): LatLon => ({ lat: (t.min.lat + t.max.lat) / 2, lon: (t.min.lon + t.max.lon) / 2 });

/** Distance from a tile's center to its farthest corner. */
export const tileHalfDiagonalKm = (t: Tile) => haversineKm(tileCenter(t), t.max);

export const fmtLatLon = (p: LatLon) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
