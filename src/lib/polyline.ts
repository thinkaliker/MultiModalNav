/** Decode a Google encoded polyline into [lon, lat] pairs (GeoJSON order). */
export function decodePolyline(encoded: string, precision = 5): [number, number][] {
  const factor = 10 ** precision;
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  // Arithmetic instead of bitwise ops: precision 6+ values can exceed 32 bits.
  const next = (): number => {
    let result = 0;
    let multiplier = 1;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result += (byte & 0x1f) * multiplier;
      multiplier *= 32;
    } while (byte >= 0x20);
    return result % 2 === 1 ? -(result + 1) / 2 : result / 2;
  };

  while (index < encoded.length) {
    lat += next();
    lon += next();
    coords.push([lon / factor, lat / factor]);
  }
  return coords;
}
