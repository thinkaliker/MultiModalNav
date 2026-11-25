// Stateless session cookie: "<expiry>.<hmac>", signed with a key derived from APP_PASSWORD,
// so changing the password invalidates every existing session.

export const COOKIE_NAME = 'mmn_session';
const SESSION_SECONDS = 30 * 24 * 3600;
const encoder = new TextEncoder();

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`multimodalnav-session:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function passwordMatches(secret: string, candidate: string): Promise<boolean> {
  // Compare MACs rather than raw strings so timing doesn't leak length or prefix.
  const [a, b] = await Promise.all([hmac(secret, `pw:${candidate}`), hmac(secret, `pw:${secret}`)]);
  return constantTimeEqual(a, b);
}

export async function createSessionCookie(secret: string, secure: boolean): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const sig = toBase64Url(await hmac(secret, `session:${exp}`));
  return [
    `${COOKIE_NAME}=${exp}.${sig}`,
    'Path=/api',
    `Max-Age=${SESSION_SECONDS}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  return [`${COOKIE_NAME}=`, 'Path=/api', 'Max-Age=0', 'HttpOnly', 'SameSite=Strict', ...(secure ? ['Secure'] : [])].join('; ');
}

export async function isValidSession(secret: string, cookieHeader: string | null): Promise<boolean> {
  if (!cookieHeader) return false;
  const match = cookieHeader.split(/;\s*/).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return false;
  const [expStr, sig] = match.slice(COOKIE_NAME.length + 1).split('.');
  const exp = Number(expStr);
  if (!sig || !Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const expected = toBase64Url(await hmac(secret, `session:${exp}`));
  return constantTimeEqual(encoder.encode(sig), encoder.encode(expected));
}
