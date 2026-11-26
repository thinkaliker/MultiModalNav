import { json, type Env } from '../_lib/env';
import { readUsage } from '../_lib/usage';

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  if (!env.USAGE_DB) return json({ tracking: false });
  try {
    return json({ tracking: true, ...(await readUsage(env.USAGE_DB, env)) });
  } catch (err) {
    // A failed read, not a missing database: the page keeps showing the last numbers.
    console.error('Usage read failed:', String(err));
    return json({ error: 'Could not read usage' }, 503);
  }
};
