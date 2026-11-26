// Subset of the MOTIS 2 API (Transitous) used by the app.
export interface MotisPlace {
  name: string;
  stopId?: string;
  parentId?: string;
  lat: number;
  lon: number;
  tz?: string;
  arrival?: string;
  departure?: string;
  scheduledArrival?: string;
  scheduledDeparture?: string;
  track?: string;
  scheduledTrack?: string;
  modes?: string[];
}

export interface EncodedPolyline {
  points: string;
  precision: number;
  length: number;
}

export interface MotisAlert {
  headerText?: string;
  descriptionText?: string;
}

export interface MotisLeg {
  mode: string;
  startTime: string;
  endTime: string;
  scheduledStartTime: string;
  scheduledEndTime: string;
  realTime: boolean;
  duration: number;
  from: MotisPlace;
  to: MotisPlace;
  legGeometry: EncodedPolyline;
  distance?: number;
  headsign?: string;
  routeShortName?: string;
  routeLongName?: string;
  displayName?: string;
  routeColor?: string;
  routeTextColor?: string;
  agencyName?: string;
  intermediateStops?: MotisPlace[];
  cancelled?: boolean;
  alerts?: MotisAlert[];
}

export interface MotisItinerary {
  duration: number;
  startTime: string;
  endTime: string;
  transfers: number;
  legs: MotisLeg[];
}

export interface PlanResponse {
  itineraries: MotisItinerary[];
  direct: MotisItinerary[];
}

export interface PlanOffset {
  stopId: string;
  duration: number;
  mode?: 'WALK' | 'BIKE' | 'CAR';
}

export interface GeocodeMatch {
  type: string;
  name: string;
  id: string;
  lat: number;
  lon: number;
  street?: string;
  houseNumber?: string;
  zip?: string;
  areas?: { name: string; adminLevel: number; matched: boolean; default?: boolean }[];
}

// Subset of the TomTom Routing API calculateRoute response.
export interface TomTomSummary {
  lengthInMeters: number;
  travelTimeInSeconds: number;
  trafficDelayInSeconds: number;
  departureTime: string;
  arrivalTime: string;
  noTrafficTravelTimeInSeconds?: number;
  historicTrafficTravelTimeInSeconds?: number;
  liveTrafficIncidentsTravelTimeInSeconds?: number;
}

export interface TomTomRouteResponse {
  routes: {
    summary: TomTomSummary;
    legs: { points: { latitude: number; longitude: number }[] }[];
  }[];
}

// Usage counters from /api/usage.
export interface UsageMeter {
  used: number;
  limit: number;
  window: 'month' | 'day';
  period: string;
}

export interface UsageReport {
  tracking: boolean;
  'tomtom.route'?: UsageMeter;
  'transitous.plan'?: UsageMeter;
}

/** Upstream calls made (or estimated) for one search. */
export interface UpstreamCounts {
  tomtom: number;
  transitous: number;
}

export interface SearchUsage extends UpstreamCounts {
  /** Answers served from the server's cache, which cost neither service anything. */
  cached: number;
}

export type { ParkingInfo, ParkingLot, ParkingStatus } from '../../functions/_lib/parking';
import type { ParkingInfo } from '../../functions/_lib/parking';

// App model.
export interface LatLon {
  lat: number;
  lon: number;
}

export interface NamedPlace extends LatLon {
  name: string;
}

export type FirstLeg = 'CAR_PARKING' | 'CAR_DROPOFF' | 'RIDESHARE' | 'BIKE' | 'WALK';
export type TransitChoice = 'LIGHT_RAIL' | 'SUBWAY' | 'TRAIN' | 'BUS' | 'FERRY';
export type LastLeg = 'WALK' | 'BIKE' | 'RENTAL' | 'RIDESHARE';

export interface TripSettings {
  firstLegs: FirstLeg[];
  transit: TransitChoice[];
  lastLegs: LastLeg[];
  maxFirstLegMin: number;
  maxLastLegMin: number;
  parkBufferMin: number;
  rideshareWaitMin: number;
  stationsToCompare: number;
  /** Trips riding fewer stops than this (all transit legs together) are dropped. */
  minTransitStops: number;
  /** Look up parking at stations (OpenStreetMap) and favour ones with free public lots. */
  prioritizeFreeParking: boolean;
}

export interface TripRequest extends TripSettings {
  from: NamedPlace;
  to: NamedPlace;
  /** null = leave now */
  time: Date | null;
  arriveBy: boolean;
}

/** One first-leg/last-leg pairing of a request; the planner runs each pairing separately. */
export interface LegCombo extends TripRequest {
  firstLeg: FirstLeg;
  lastLeg: LastLeg;
}

export interface DisplayLeg {
  mode: string; // MOTIS mode, or one of the app's own: 'PARK', 'WAIT', 'RIDESHARE'
  label: string;
  startTime: string;
  endTime: string;
  durationSec: number;
  from: NamedPlace;
  to: NamedPlace;
  tz?: string;
  coords: [number, number][]; // [lon, lat]
  color: string;
  textColor: string;
  dashed: boolean;
  realTime: boolean;
  routeShortName?: string;
  headsign?: string;
  agencyName?: string;
  stopCount?: number;
  track?: string;
  distanceM?: number;
  trafficDelaySec?: number;
  trafficEstimated?: boolean;
  cancelled?: boolean;
  alerts?: string[];
}

export interface TripOption {
  id: string;
  kind: 'parkride' | 'transit' | 'direct';
  title: string;
  startTime: string;
  endTime: string;
  durationSec: number;
  transfers: number;
  legs: DisplayLeg[];
  station?: NamedPlace;
  /** Later/earlier departures from the same station (start/end times only). */
  alternatives: { startTime: string; endTime: string }[];
  traffic?: { label: 'Drive' | 'Ride'; driveSec: number; delaySec: number; estimated: boolean };
  realTime: boolean;
  /** Parking where this option leaves the car, when it was looked up. */
  parking?: ParkingInfo;
  /** Seconds counted against this option when ranking, beyond its time (paid parking, say). */
  penaltySec?: number;
}
