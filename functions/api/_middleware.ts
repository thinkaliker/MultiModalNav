import { isValidSession } from '../_lib/auth';
import { json, type Env } from '../_lib/env';

const PUBLIC_PATHS = new Set(['/api/login', '/api/logout']);

export const onRequest: PagesFunction<Env> = async ({ request, env, next }) => {
  const { pathname } = new URL(request.url);
  if (PUBLIC_PATHS.has(pathname)) return next();
  if (!env.APP_PASSWORD) return json({ error: 'APP_PASSWORD is not configured' }, 500);
  if (!(await isValidSession(env.APP_PASSWORD, request.headers.get('Cookie')))) {
    return json({ error: 'unauthorized' }, 401);
  }
  return next();
};
