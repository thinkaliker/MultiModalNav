import { describe, expect, it } from 'vitest';
import { decodePolyline } from '../src/lib/polyline';

describe('decodePolyline', () => {
  it('decodes the reference example at precision 5', () => {
    // From Google's polyline algorithm documentation.
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5)).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
  });

  it('round-trips precision 6 coordinates without 32-bit overflow', () => {
    const encode = (coords: [number, number][], precision: number) => {
      const factor = 10 ** precision;
      let out = '';
      let prevLat = 0;
      let prevLon = 0;
      const enc = (v: number) => {
        let n = v < 0 ? -2 * v - 1 : 2 * v;
        let s = '';
        while (n >= 0x20) {
          s += String.fromCharCode((0x20 | (n % 32)) + 63);
          n = Math.floor(n / 32);
        }
        return s + String.fromCharCode(n + 63);
      };
      for (const [lon, lat] of coords) {
        const la = Math.round(lat * factor);
        const lo = Math.round(lon * factor);
        out += enc(la - prevLat) + enc(lo - prevLon);
        prevLat = la;
        prevLon = lo;
      }
      return out;
    };
    const coords: [number, number][] = [
      [-118.340600, 33.835800],
      [-118.491200, 34.019500],
      [151.209296, -33.86882],
    ];
    expect(decodePolyline(encode(coords, 6), 6)).toEqual(coords);
  });
});
