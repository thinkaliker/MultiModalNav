import { json, type Env } from '../_lib/env';
import { readUsage } from '../_lib/usage';

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  if (!env.USAGE_DB) return json({ tracking: false });
  try {
    return json({ tracking: true, ...(await readUsage(env.USAGE_DB, env)) });
  } catch (err) {
    return json({ tracking: false, error: String(err) });
  }
};
