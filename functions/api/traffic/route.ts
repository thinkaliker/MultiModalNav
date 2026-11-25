import { json, type Env } from '../../_lib/env';

// Traffic-aware car route via the TomTom Routing API. The API key never leaves the server.
// GET /api/traffic/route?from=lat,lon&to=lat,lon[&departAt=ISO|now]

const COORD = /^-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;

function validCoord(value: string | null): value is string {
  if (!value || !COORD.test(value)) return false;
  const [lat, lon] = value.split(',').map(Number);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function validTime(value: string | null): value is string {
  return value !== null && !Number.isNaN(Date.parse(value));
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.TOMTOM_API_KEY) return json({ error: 'traffic_unconfigured' }, 503);

  const q = new URL(request.url).searchParams;
  const from = q.get('from');
  const to = q.get('to');
  if (!validCoord(from) || !validCoord(to)) return json({ error: 'from/to must be "lat,lon"' }, 400);

  const params = new URLSearchParams({
    key: env.TOMTOM_API_KEY,
    traffic: 'true',
    travelMode: 'car',
    routeType: 'fastest',
    computeTravelTimeFor: 'all',
    routeRepresentation: 'polyline',
  });
  const departAt = q.get('departAt') ?? 'now';
  if (departAt !== 'now' && !validTime(departAt)) return json({ error: 'bad departAt' }, 400);
  params.set('departAt', departAt);

  const upstream = await fetch(
    `https://api.tomtom.com/routing/1/calculateRoute/${from}:${to}/json?${params}`,
    { headers: { Accept: 'application/json' } },
  );
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
