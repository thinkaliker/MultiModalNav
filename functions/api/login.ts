import { createSessionCookie, passwordMatches } from '../_lib/auth';
import { json, type Env } from '../_lib/env';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.APP_PASSWORD) return json({ error: 'APP_PASSWORD is not configured' }, 500);
  let password = '';
  try {
    const body = (await request.json()) as { password?: unknown };
    if (typeof body.password === 'string') password = body.password;
  } catch {
    return json({ error: 'invalid body' }, 400);
  }
  if (!(await passwordMatches(env.APP_PASSWORD, password))) {
    return json({ error: 'wrong password' }, 401);
  }
  const secure = new URL(request.url).protocol === 'https:';
  return json({ ok: true }, 200, { 'Set-Cookie': await createSessionCookie(env.APP_PASSWORD, secure) });
};
