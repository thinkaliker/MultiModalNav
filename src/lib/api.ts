import { fmtLatLon } from './geo';
import type {
  GeocodeMatch,
  LatLon,
  MotisPlace,
  PlanOffset,
  PlanResponse,
  TomTomRouteResponse,
  UsageReport,
} from './types';

export class AuthError extends Error {
  constructor() {
    super('Not signed in');
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Status from the upstream service, when the proxy reports one. */
    public upstreamStatus?: number,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let upstreamStatus: number | undefined;
    try {
      const body = await res.json();
      message = body.error ?? JSON.stringify(body);
      upstreamStatus = typeof body.upstreamStatus === 'number' ? body.upstreamStatus : undefined;
    } catch {
      // keep the status message
    }
    throw new ApiError(res.status, message, upstreamStatus);
  }
  return res.json() as Promise<T>;
}

const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') search.set(k, String(v));
  return search.toString();
};

export type PlanParams = Record<string, string | number | boolean | undefined>;

export interface DriveTiming {
  departAt?: string;
  arriveAt?: string;
}

export const api = {
  session: () => request<{ ok: boolean; traffic: boolean }>('/api/session'),

  login: (password: string) =>
    request<{ ok: boolean }>('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }),

  logout: () => request<{ ok: boolean }>('/api/logout', { method: 'POST' }),

  usage: () => request<UsageReport>('/api/usage'),

  geocode: (text: string, near: LatLon | null, signal?: AbortSignal) =>
    request<GeocodeMatch[]>(
      // The default bias (1) barely matters; 5 favours nearby matches without drowning out the text.
      `/api/transit/v1/geocode?${qs({ text, place: near ? fmtLatLon(near) : undefined, placeBias: near ? 5 : undefined })}`,
      { signal },
    ),

  stops: (min: LatLon, max: LatLon, signal?: AbortSignal) =>
    request<MotisPlace[]>(
      `/api/transit/v6/map/stops?${qs({ min: fmtLatLon(min), max: fmtLatLon(max), grouped: true })}`,
      { signal },
    ),

  plan: (params: PlanParams, signal?: AbortSignal) =>
    request<PlanResponse>(`/api/transit/v6/plan?${qs(params)}`, { signal }),

  /** Plan with client-computed first and/or last miles, which replace Transitous's own. */
  planWithOffsets: (
    params: PlanParams,
    offsets: { fromOffsets?: PlanOffset[]; toOffsets?: PlanOffset[] },
    signal?: AbortSignal,
  ) =>
    request<PlanResponse>(`/api/transit/v6/plan?${qs(params)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(offsets),
      signal,
    }),

  trafficRoute: (from: LatLon, to: LatLon, timing: DriveTiming, signal?: AbortSignal) =>
    request<TomTomRouteResponse>(
      `/api/traffic/route?${qs({ from: fmtLatLon(from), to: fmtLatLon(to), ...timing })}`,
      { signal },
    ),
};
