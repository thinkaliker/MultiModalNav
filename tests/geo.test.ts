import { describe, expect, it } from 'vitest';
import { haversineKm, tilesAround } from '../src/lib/geo';

describe('geo', () => {
  it('measures distance between Torrance and Santa Monica', () => {
    const d = haversineKm({ lat: 33.8358, lon: -118.3406 }, { lat: 34.0195, lon: -118.4912 });
    expect(d).toBeGreaterThan(24);
    expect(d).toBeLessThan(26);
  });

  it('covers the search circle with stable grid tiles', () => {
    const a = tilesAround({ lat: 33.8358, lon: -118.3406 }, 24);
    const b = tilesAround({ lat: 33.84, lon: -118.345 }, 24);
    expect(a.length).toBeGreaterThanOrEqual(4);
    expect(a.length).toBeLessThanOrEqual(12);
    // Nearby origins should reuse mostly the same tiles (cache hits).
    const keys = new Set(a.map((t) => t.key));
    expect(b.filter((t) => keys.has(t.key)).length).toBeGreaterThanOrEqual(b.length - 3);
    for (const t of a) {
      expect(t.max.lat - t.min.lat).toBeCloseTo(0.25);
      expect(t.max.lon - t.min.lon).toBeCloseTo(0.25);
    }
  });
});
