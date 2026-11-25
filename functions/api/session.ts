import { json, type Env } from '../_lib/env';

// Reaching this handler means the middleware accepted the session cookie.
export const onRequestGet: PagesFunction<Env> = async ({ env }) =>
  json({ ok: true, traffic: Boolean(env.TOMTOM_API_KEY) });
