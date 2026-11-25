import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import { userAgent } from '../functions/_lib/useragent';

describe('Transitous User-Agent', () => {
  it('includes the app, version, project URL and contact', () => {
    expect(userAgent('me@example.com')).toBe(
      `MultiModalNav/${pkg.version} (+https://github.com/thinkaliker/MultiModalNav; me@example.com)`,
    );
  });

  it('omits the contact when unset', () => {
    expect(userAgent(undefined)).toBe(`MultiModalNav/${pkg.version} (+https://github.com/thinkaliker/MultiModalNav)`);
    expect(userAgent('   ')).toBe(`MultiModalNav/${pkg.version} (+https://github.com/thinkaliker/MultiModalNav)`);
  });

  it('strips characters that would break the header', () => {
    expect(userAgent('me@example.com\r\nX-Evil: 1 (hi); ok')).toBe(
      `MultiModalNav/${pkg.version} (+https://github.com/thinkaliker/MultiModalNav; me@example.comX-Evil: 1 hi ok)`,
    );
  });
});
