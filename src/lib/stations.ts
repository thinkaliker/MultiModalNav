import { api } from './api';
import { tilesAround, type Tile } from './geo';
import type { LatLon, MotisPlace } from './types';

// Requests are shared per grid tile (and cached by the service worker), so overlapping
// searches don't re-download station lists.
const tileCache = new Map<string, Promise<MotisPlace[]>>();

function loadTile(key: string, min: LatLon, max: LatLon): Promise<MotisPlace[]> {
  let pending = tileCache.get(key);
  if (!pending) {
    pending = api.stops(min, max).catch((err) => {
      tileCache.delete(key);
      throw err;
    });
    tileCache.set(key, pending);
  }
  return pending;
}

/**
 * Stations within roughly `radiusKm` of `center` served by any of `modes`.
 * `keepTile` can skip grid tiles that can't contain useful stations.
 */
export async function stationsNear(
  center: LatLon,
  radiusKm: number,
  modes: string[],
  keepTile: (tile: Tile) => boolean = () => true,
): Promise<MotisPlace[]> {
  const wanted = new Set(modes);
  const tiles = tilesAround(center, radiusKm).filter(keepTile);
  const lists = await Promise.all(tiles.map((t) => loadTile(t.key, t.min, t.max)));
  const seen = new Set<string>();
  const stations: MotisPlace[] = [];
  for (const stop of lists.flat()) {
    const id = stop.stopId ?? `${stop.lat},${stop.lon}`;
    if (seen.has(id) || !stop.modes?.some((m) => wanted.has(m))) continue;
    seen.add(id);
    stations.push(stop);
  }
  return stations;
}
