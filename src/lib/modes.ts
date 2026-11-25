import type { FirstLeg, LastLeg, TransitChoice } from './types';

export const FIRST_LEG_OPTIONS: { id: FirstLeg; label: string; icon: string }[] = [
  { id: 'CAR_PARKING', label: 'Drive & park', icon: '🚗' },
  { id: 'CAR_DROPOFF', label: 'Drop-off', icon: '🚕' },
  { id: 'BIKE', label: 'Bike', icon: '🚲' },
  { id: 'WALK', label: 'Walk', icon: '🚶' },
];

export const TRANSIT_OPTIONS: { id: TransitChoice; label: string; icon: string; modes: string[] }[] = [
  { id: 'LIGHT_RAIL', label: 'Light rail', icon: '🚊', modes: ['TRAM'] },
  { id: 'SUBWAY', label: 'Subway', icon: '🚇', modes: ['SUBWAY'] },
  {
    id: 'TRAIN',
    label: 'Train',
    icon: '🚆',
    modes: ['REGIONAL_RAIL', 'SUBURBAN', 'LONG_DISTANCE', 'HIGHSPEED_RAIL', 'NIGHT_RAIL'],
  },
  { id: 'BUS', label: 'Bus', icon: '🚌', modes: ['BUS', 'COACH'] },
  { id: 'FERRY', label: 'Ferry', icon: '⛴️', modes: ['FERRY'] },
];

export const LAST_LEG_OPTIONS: { id: LastLeg; label: string; icon: string }[] = [
  { id: 'WALK', label: 'Walk', icon: '🚶' },
  { id: 'BIKE', label: 'Own bike', icon: '🚲' },
  { id: 'RENTAL', label: 'Bike/scooter share', icon: '🛴' },
];

export function motisTransitModes(choices: TransitChoice[]): string[] {
  return TRANSIT_OPTIONS.filter((o) => choices.includes(o.id)).flatMap((o) => o.modes);
}

export const isCarFirst = (first: FirstLeg) => first === 'CAR_PARKING' || first === 'CAR_DROPOFF';

export const STREET_MODES = new Set(['WALK', 'BIKE', 'RENTAL', 'CAR', 'CAR_PARKING', 'CAR_DROPOFF', 'FLEX', 'ODM', 'PARK']);

const MODE_STYLE: Record<string, { color: string; icon: string }> = {
  CAR: { color: '#475569', icon: '🚗' },
  PARK: { color: '#64748b', icon: '🅿️' },
  WALK: { color: '#6b7280', icon: '🚶' },
  BIKE: { color: '#16a34a', icon: '🚲' },
  RENTAL: { color: '#0d9488', icon: '🛴' },
  TRAM: { color: '#2563eb', icon: '🚊' },
  SUBWAY: { color: '#7c3aed', icon: '🚇' },
  REGIONAL_RAIL: { color: '#b45309', icon: '🚆' },
  SUBURBAN: { color: '#b45309', icon: '🚆' },
  LONG_DISTANCE: { color: '#9a3412', icon: '🚆' },
  HIGHSPEED_RAIL: { color: '#9a3412', icon: '🚄' },
  NIGHT_RAIL: { color: '#9a3412', icon: '🚆' },
  BUS: { color: '#dc2626', icon: '🚌' },
  COACH: { color: '#be123c', icon: '🚌' },
  FERRY: { color: '#0891b2', icon: '⛴️' },
};

export const modeIcon = (mode: string) => MODE_STYLE[mode]?.icon ?? '🚉';

export function modeColor(mode: string, routeColor?: string): string {
  if (routeColor && /^[0-9a-fA-F]{6}$/.test(routeColor)) return `#${routeColor}`;
  return MODE_STYLE[mode]?.color ?? '#334155';
}

export function modeTextColor(routeTextColor?: string): string {
  return routeTextColor && /^[0-9a-fA-F]{6}$/.test(routeTextColor) ? `#${routeTextColor}` : '#ffffff';
}
