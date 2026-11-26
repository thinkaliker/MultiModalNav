import type { ParkingInfo, ParkingStatus } from './types';

export function fmtDuration(seconds: number): string {
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function fmtTime(iso: string, timeZone?: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone });
  } catch {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
}

export function fmtDistance(meters: number): string {
  const miles = meters / 1609.344;
  return miles < 0.2 ? `${Math.round(meters * 3.28084)} ft` : `${miles.toFixed(1)} mi`;
}

/** "2026-12-01T08:00" in local time, for <input type="datetime-local">. */
export function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const PARKING_LABEL: Record<Exclude<ParkingStatus, 'unknown'>, string> = {
  free: 'Free parking',
  paid: 'Paid parking',
  none: 'No public parking',
};

/** A short label for a station's parking, for result cards. */
export const parkingLabel = (info: ParkingInfo) =>
  info.status === 'unknown' ? (info.lot ? 'Parking fee not mapped' : 'No parking mapped') : PARKING_LABEL[info.status];

/** The lot behind a parking status, in a sentence. */
export function parkingDetail(info: ParkingInfo): string {
  const lot = info.lot;
  const where = lot ? `${lot.name ? `${lot.name}, ` : ''}${fmtDistance(lot.distanceM)} from the platform` : '';
  switch (info.status) {
    case 'free':
      return `Free ${lot?.parkRide ? 'park & ride' : 'public'} lot: ${where}`;
    case 'paid':
      return `Paid lot${lot?.fee && lot.fee !== 'yes' ? ` (fee: ${lot.fee})` : ''}: ${where}`;
    case 'none':
      return 'Only private or customer parking is mapped near this station.';
    default:
      return lot ? `Public lot, fees not mapped: ${where}` : 'No parking is mapped near this station.';
  }
}
