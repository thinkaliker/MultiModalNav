import { clearSessionCookie } from '../_lib/auth';
import { json, type Env } from '../_lib/env';

export const onRequestPost: PagesFunction<Env> = async ({ request }) => {
  const secure = new URL(request.url).protocol === 'https:';
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(secure) });
};
