<script lang="ts">
  import type { FeatureCollection } from 'geojson';
  import {
    AttributionControl,
    GeolocateControl,
    LngLatBounds,
    Map as MapLibreMap,
    Marker,
    NavigationControl,
    type FilterSpecification,
    type GeoJSONSource,
    setWorkerUrl,
  } from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
  import { onDestroy, onMount } from 'svelte';
  import type { LatLon, NamedPlace, TripOption } from '../lib/types';

  // MapLibre looks for its worker next to its own module, which no longer exists once bundled.
  setWorkerUrl(workerUrl);

  interface Props {
    from: NamedPlace | null;
    to: NamedPlace | null;
    option: TripOption | null;
    options: TripOption[];
    picking: 'from' | 'to' | null;
    onpick: (p: LatLon) => void;
    onselect: (id: string) => void;
    onlocate: (p: LatLon) => void;
    onviewchange?: (center: LatLon) => void;
  }

  let { from, to, option, options, picking, onpick, onselect, onlocate, onviewchange }: Props = $props();

  const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
  const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

  let container: HTMLDivElement;
  let map: MapLibreMap | undefined;
  let ready = $state(false);
  let endMarkers: Record<'from' | 'to', Marker | undefined> = { from: undefined, to: undefined };
  let stationMarkers: Marker[] = [];
  let resizeObserver: ResizeObserver | undefined;

  onMount(() => {
    map = new MapLibreMap({
      container,
      style: STYLE_URL,
      center: [-117.7, 33.5], // Southern California
      zoom: 7.3,
      attributionControl: false,
    });
    map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    const geolocate = new GeolocateControl({ positionOptions: { enableHighAccuracy: true } });
    geolocate.on('geolocate', (e) => onlocate({ lat: e.coords.latitude, lon: e.coords.longitude }));
    map.addControl(geolocate, 'top-right');

    map.on('load', () => {
      map!.addSource('route', { type: 'geojson', data: EMPTY });
      const solid: FilterSpecification = ['!', ['get', 'dashed']];
      map!.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route',
        filter: solid,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 9 },
      });
      map!.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        filter: solid,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': 5 },
      });
      map!.addLayer({
        id: 'route-dashed',
        type: 'line',
        source: 'route',
        filter: ['get', 'dashed'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-dasharray': [0.2, 1.6] },
      });
      ready = true;
    });

    const reportView = () => {
      const c = map!.getCenter();
      onviewchange?.({ lat: c.lat, lon: c.lng });
    };
    map.on('moveend', reportView);
    reportView();

    map.on('click', (e) => {
      if (picking) onpick({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    });

    resizeObserver = new ResizeObserver(() => map?.resize());
    resizeObserver.observe(container);
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    map?.remove();
  });

  function routeGeoJSON(opt: TripOption | null): FeatureCollection {
    if (!opt) return EMPTY;
    return {
      type: 'FeatureCollection',
      features: opt.legs
        .filter((leg) => leg.coords.length >= 2)
        .map((leg) => ({
          type: 'Feature',
          properties: { color: leg.color, dashed: leg.dashed },
          geometry: { type: 'LineString', coordinates: leg.coords },
        })),
    };
  }

  function fitTo(points: [number, number][]) {
    if (!map || points.length === 0) return;
    const bounds = points.reduce(
      (b, p) => b.extend(p),
      new LngLatBounds(points[0], points[0]),
    );
    map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 600 });
  }

  // Selected route.
  $effect(() => {
    const opt = option;
    if (!ready || !map) return;
    (map.getSource('route') as GeoJSONSource).setData(routeGeoJSON(opt));
    if (opt) fitTo(opt.legs.flatMap((l) => l.coords));
  });

  // Start/end markers; frame them when there's no route to show.
  $effect(() => {
    const places = { from, to };
    if (!map) return;
    for (const kind of ['from', 'to'] as const) {
      const place = places[kind];
      endMarkers[kind]?.remove();
      endMarkers[kind] = undefined;
      if (!place) continue;
      const el = document.createElement('div');
      el.className = `marker-end ${kind}`;
      el.title = place.name;
      endMarkers[kind] = new Marker({ element: el }).setLngLat([place.lon, place.lat]).addTo(map);
    }
    if (!option) {
      const pts = [from, to].filter((p): p is NamedPlace => p !== null).map((p) => [p.lon, p.lat] as [number, number]);
      if (pts.length === 2) fitTo(pts);
      else if (pts.length === 1) map.easeTo({ center: pts[0], zoom: Math.max(map.getZoom(), 12) });
    }
  });

  // Numbered markers for each suggested station.
  $effect(() => {
    const selectedId = option?.id;
    if (!map) return;
    for (const m of stationMarkers) m.remove();
    stationMarkers = [];
    const seen = new Set<string>();
    options.forEach((opt, i) => {
      if (!opt.station || seen.has(opt.station.name)) return;
      seen.add(opt.station.name);
      const el = document.createElement('button');
      el.className = `marker-station${opt.id === selectedId ? ' selected' : ''}`;
      el.textContent = String(i + 1);
      el.title = opt.title;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        onselect(opt.id);
      });
      stationMarkers.push(new Marker({ element: el }).setLngLat([opt.station.lon, opt.station.lat]).addTo(map!));
    });
  });

  $effect(() => {
    if (map) map.getCanvas().style.cursor = picking ? 'crosshair' : '';
  });
</script>

<div class="map" bind:this={container}></div>

<style>
  .map {
    position: absolute;
    inset: 0;
  }
</style>
