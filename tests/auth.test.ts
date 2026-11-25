import { describe, expect, it } from 'vitest';
import { COOKIE_NAME, createSessionCookie, isValidSession, passwordMatches } from '../functions/_lib/auth';

const tokenFrom = (setCookie: string) => setCookie.split(';')[0];

describe('session auth', () => {
  it('checks the password', async () => {
    expect(await passwordMatches('hunter2', 'hunter2')).toBe(true);
    expect(await passwordMatches('hunter2', 'hunter3')).toBe(false);
    expect(await passwordMatches('hunter2', '')).toBe(false);
  });

  it('accepts its own cookie and rejects tampering or a changed password', async () => {
    const cookie = tokenFrom(await createSessionCookie('hunter2', true));
    expect(cookie.startsWith(`${COOKIE_NAME}=`)).toBe(true);
    expect(await isValidSession('hunter2', `other=1; ${cookie}`)).toBe(true);
    expect(await isValidSession('changed', cookie)).toBe(false);
    const [, value] = cookie.split('=');
    const [exp, sig] = value.split('.');
    expect(await isValidSession('hunter2', `${COOKIE_NAME}=${Number(exp) + 1000}.${sig}`)).toBe(false);
    expect(await isValidSession('hunter2', null)).toBe(false);
  });

  it('marks cookies Secure only over https', async () => {
    expect(await createSessionCookie('x', true)).toContain('Secure');
    expect(await createSessionCookie('x', false)).not.toContain('Secure');
  });
});
