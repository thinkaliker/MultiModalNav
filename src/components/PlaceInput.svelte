<script lang="ts">
  import { api, AuthError } from '../lib/api';
  import type { GeocodeMatch, LatLon, NamedPlace } from '../lib/types';

  interface Props {
    label: string;
    value: NamedPlace | null;
    near: LatLon | null;
    onpickmap: () => void;
    onlocated?: (p: LatLon) => void;
    onauth?: () => void;
  }

  let { label, value = $bindable(), near, onpickmap, onlocated, onauth }: Props = $props();

  let text = $state(value?.name ?? '');
  let suggestions = $state<GeocodeMatch[]>([]);
  let open = $state(false);
  let locating = $state(false);
  let message = $state('');
  let syncedName = value?.name ?? '';
  let localEdit = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const inputId = `place-${Math.random().toString(36).slice(2, 8)}`;

  // Reflect changes made from outside (map pick, swap, current location).
  $effect(() => {
    const name = value?.name ?? null;
    if (name === null) {
      if (!localEdit) text = '';
      localEdit = false;
      syncedName = '';
    } else if (name !== syncedName) {
      syncedName = name;
      text = name;
    }
  });

  function oninput() {
    message = '';
    if (value) {
      localEdit = true;
      value = null;
    }
    clearTimeout(timer);
    controller?.abort();
    const query = text.trim();
    if (query.length < 3) {
      suggestions = [];
      return;
    }
    timer = setTimeout(async () => {
      controller = new AbortController();
      try {
        suggestions = (await api.geocode(query, near, controller.signal)).slice(0, 6);
        open = true;
      } catch (err) {
        if (err instanceof AuthError) onauth?.();
        else if ((err as Error).name !== 'AbortError') message = 'Search failed';
      }
    }, 250);
  }

  function choose(match: GeocodeMatch) {
    const name = match.houseNumber && match.street ? `${match.houseNumber} ${match.street}` : match.name;
    syncedName = name;
    text = name;
    value = { name, lat: match.lat, lon: match.lon };
    open = false;
    suggestions = [];
  }

  function secondary(match: GeocodeMatch): string {
    const areas = (match.areas ?? []).filter((a) => a.default || a.adminLevel === 8 || a.adminLevel === 4);
    return [...new Set(areas.map((a) => a.name))].slice(0, 2).join(', ');
  }

  function useCurrentLocation() {
    if (!navigator.geolocation) {
      message = 'Location is not available in this browser';
      return;
    }
    locating = true;
    message = '';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locating = false;
        const p = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        value = { name: 'Current location', ...p };
        onlocated?.(p);
      },
      (err) => {
        locating = false;
        message = err.code === err.PERMISSION_DENIED ? 'Location permission denied' : 'Could not get your location';
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  }
</script>

<div class="place">
  <label for={inputId}>{label}</label>
  <div class="row">
    <input
      id={inputId}
      type="search"
      autocomplete="off"
      placeholder="Address, place or stop"
      bind:value={text}
      {oninput}
      onfocus={() => (open = suggestions.length > 0)}
      onblur={() => setTimeout(() => (open = false), 150)}
    />
    <button type="button" class="icon" title="Use current location" aria-label="Use current location" onclick={useCurrentLocation} disabled={locating}>
      {locating ? '…' : '📍'}
    </button>
    <button type="button" class="icon" title="Pick on map" aria-label="Pick on map" onclick={onpickmap}>🗺️</button>
  </div>
  {#if open && suggestions.length}
    <ul class="suggestions">
      {#each suggestions as match (match.id)}
        <li>
          <button type="button" onpointerdown={(e) => { e.preventDefault(); choose(match); }}>
            <span>{match.houseNumber && match.street ? `${match.houseNumber} ${match.street}` : match.name}</span>
            <small>{match.type === 'STOP' ? 'Transit stop · ' : ''}{secondary(match)}</small>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if message}<p class="message">{message}</p>{/if}
</div>

<style>
  .place {
    position: relative;
  }
  label {
    display: block;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--muted);
    margin-bottom: 0.2rem;
  }
  .row {
    display: flex;
    gap: 0.35rem;
  }
  input {
    flex: 1;
    min-width: 0;
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: #fff;
  }
  .icon {
    flex: none;
    width: 2.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: #fff;
  }
  .suggestions {
    position: absolute;
    z-index: 10;
    left: 0;
    right: 0;
    margin: 0.2rem 0 0;
    padding: 0.25rem 0;
    list-style: none;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.12);
  }
  .suggestions button {
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 0.45rem 0.7rem;
    border: 0;
    background: none;
    text-align: left;
  }
  .suggestions button:hover {
    background: var(--bg);
  }
  small {
    color: var(--muted);
  }
  .message {
    margin: 0.25rem 0 0;
    font-size: 0.8rem;
    color: var(--danger);
  }
</style>
