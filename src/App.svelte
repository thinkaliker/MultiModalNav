<script lang="ts">
  import { onMount, tick } from 'svelte';
  import ItineraryDetail from './components/ItineraryDetail.svelte';
  import LegPicker from './components/LegPicker.svelte';
  import Login from './components/Login.svelte';
  import MapView from './components/MapView.svelte';
  import PlaceInput from './components/PlaceInput.svelte';
  import ResultsList from './components/ResultsList.svelte';
  import UsageFooter from './components/UsageFooter.svelte';
  import { api, AuthError } from './lib/api';
  import { toLocalInputValue } from './lib/format';
  import { estimateCost, planTrip, type PlanResult } from './lib/planner';
  import { load, save } from './lib/storage';
  import type { LatLon, NamedPlace, TripSettings, UsageReport } from './lib/types';

  const DEFAULT_SETTINGS: TripSettings = {
    firstLegs: ['CAR_PARKING'],
    transit: ['LIGHT_RAIL', 'SUBWAY', 'TRAIN'],
    lastLegs: ['WALK'],
    maxFirstLegMin: 30,
    maxLastLegMin: 15,
    parkBufferMin: 5,
    rideshareWaitMin: 6,
    stationsToCompare: 6,
    minTransitStops: 3,
    prioritizeFreeParking: true,
  };

  let auth = $state<'checking' | 'signed-out' | 'signed-in'>('checking');
  let trafficEnabled = $state(false);
  // v2: first/last legs became lists; older saved settings are ignored.
  let settings = $state<TripSettings>(load('settings.v2', DEFAULT_SETTINGS));
  let from = $state<NamedPlace | null>(null);
  let to = $state<NamedPlace | null>(null);
  let timeMode = $state<'now' | 'depart' | 'arrive'>('now');
  let timeValue = $state(toLocalInputValue(new Date()));
  let picking = $state<'from' | 'to' | null>(null);
  let userLocation = $state<LatLon | null>(null);
  let mapCenter = $state<LatLon | null>(null);
  let busy = $state(false);
  let progress = $state('');
  let error = $state('');
  let result = $state<PlanResult | null>(null);
  let selectedId = $state<string | null>(null);
  let detailOpen = $state(false);
  let mapExpanded = $state(false);
  let usage = $state<UsageReport | null>(null);
  let controller: AbortController | undefined;
  let resultsTop: HTMLElement | undefined = $state();

  const allOptions = $derived(result ? [...result.options, ...result.direct] : []);
  const estimate = $derived(estimateCost(settings, trafficEnabled));
  const selected = $derived(allOptions.find((o) => o.id === selectedId) ?? null);

  $effect(() => save('settings.v2', $state.snapshot(settings)));

  async function checkSession() {
    try {
      const session = await api.session();
      trafficEnabled = session.traffic;
      auth = 'signed-in';
      refreshUsage();
    } catch (err) {
      auth = 'signed-out';
      if (!(err instanceof AuthError)) error = (err as Error).message;
    }
  }

  onMount(checkSession);

  async function refreshUsage() {
    try {
      usage = await api.usage();
    } catch {
      usage = null;
    }
  }

  async function search(event?: SubmitEvent) {
    event?.preventDefault();
    if (!from || !to) {
      error = 'Choose a start and a destination.';
      return;
    }
    if (!settings.transit.length) {
      error = 'Pick at least one transit mode.';
      return;
    }
    controller?.abort();
    controller = new AbortController();
    busy = true;
    error = '';
    result = null;
    selectedId = null;
    detailOpen = false;
    try {
      const res = await planTrip(
        {
          ...$state.snapshot(settings),
          from: $state.snapshot(from),
          to: $state.snapshot(to),
          time: timeMode === 'now' ? null : new Date(timeValue),
          arriveBy: timeMode === 'arrive',
        },
        { trafficEnabled, signal: controller.signal, onProgress: (m) => (progress = m) },
      );
      result = res;
      selectedId = res.options[0]?.id ?? res.direct[0]?.id ?? null;
      await tick();
      resultsTop?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      if (err instanceof AuthError) auth = 'signed-out';
      else if ((err as Error).name !== 'AbortError') error = (err as Error).message;
    } finally {
      busy = false;
      progress = '';
      if (auth === 'signed-in') refreshUsage();
    }
  }

  function swap() {
    [from, to] = [to, from];
  }

  function onPick(p: LatLon) {
    const place = { name: `Pin ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`, ...p };
    if (picking === 'from') from = place;
    else if (picking === 'to') to = place;
    picking = null;
    mapExpanded = false;
  }

  function startPicking(which: 'from' | 'to') {
    picking = which;
    mapExpanded = true;
  }

  async function logout() {
    await api.logout().catch(() => {});
    auth = 'signed-out';
  }
</script>

<div class="app" class:map-expanded={mapExpanded}>
  <div class="map-wrap">
    <MapView
      {from}
      {to}
      option={selected}
      options={allOptions}
      {picking}
      onpick={onPick}
      onselect={(id) => (selectedId = id)}
      onlocate={(p) => (userLocation = p)}
      onviewchange={(c) => (mapCenter = c)}
    />
    {#if picking}
      <div class="pick-hint">
        Tap the map to set the {picking === 'from' ? 'start' : 'destination'}
        <button type="button" onclick={() => { picking = null; mapExpanded = false; }}>Cancel</button>
      </div>
    {/if}
    <button type="button" class="expand" onclick={() => (mapExpanded = !mapExpanded)}>
      {mapExpanded ? '▾ Show panel' : '▴ Bigger map'}
    </button>
  </div>

  <aside class="panel">
    {#if detailOpen && selected}
      <ItineraryDetail option={selected} onback={() => (detailOpen = false)} />
    {:else}
      <header>
        <h1>MultiModalNav</h1>
        {#if auth === 'signed-in'}
          <span class="badge" class:off={!trafficEnabled} title={trafficEnabled ? 'Traffic-aware drive times' : 'TOMTOM_API_KEY not set'}>
            {trafficEnabled ? 'traffic on' : 'no traffic'}
          </span>
          <button type="button" class="link" onclick={logout}>Sign out</button>
        {/if}
      </header>

      <form onsubmit={search}>
        <div class="places">
          <PlaceInput label="From" bind:value={from} near={userLocation ?? mapCenter} onpickmap={() => startPicking('from')} onlocated={(p) => (userLocation = p)} onauth={() => (auth = 'signed-out')} />
          <button type="button" class="swap" onclick={swap} title="Swap start and destination" aria-label="Swap start and destination">⇅</button>
          <PlaceInput label="To" bind:value={to} near={userLocation ?? from ?? mapCenter} onpickmap={() => startPicking('to')} onlocated={(p) => (userLocation = p)} onauth={() => (auth = 'signed-out')} />
        </div>

        <div class="time">
          <select bind:value={timeMode} aria-label="Departure or arrival">
            <option value="now">Leave now</option>
            <option value="depart">Depart at</option>
            <option value="arrive">Arrive by</option>
          </select>
          {#if timeMode !== 'now'}
            <input type="datetime-local" bind:value={timeValue} aria-label="Date and time" />
          {/if}
        </div>

        <LegPicker bind:settings />

        <button type="submit" class="primary" disabled={busy || auth !== 'signed-in'}>
          {busy ? progress || 'Searching…' : 'Find routes'}
        </button>
        <p class="cost estimate">
          Uses up to {estimate.tomtom} TomTom route{estimate.tomtom === 1 ? '' : 's'} and
          {estimate.transitous} Transitous quer{estimate.transitous === 1 ? 'y' : 'ies'}.
        </p>
      </form>

      {#if error}<p class="error">{error}</p>{/if}

      {#if result}
        <div bind:this={resultsTop}></div>
        {#each result.notes as note}<p class="note">{note}</p>{/each}
        <p class="cost">
          This search used {result.usage.tomtom} TomTom route{result.usage.tomtom === 1 ? '' : 's'} and
          {result.usage.transitous} Transitous quer{result.usage.transitous === 1 ? 'y' : 'ies'}{#if result.usage.cached}
            , plus {result.usage.cached} answer{result.usage.cached === 1 ? '' : 's'} from the cache{/if}.
        </p>
        <ResultsList
          options={result.options}
          direct={result.direct}
          {selectedId}
          onselect={(id) => (selectedId = id)}
          onopen={(id) => { selectedId = id; detailOpen = true; }}
        />
      {/if}

      <footer>
        {#if auth === 'signed-in'}<UsageFooter report={usage} />{/if}
        Transit routing by <a href="https://transitous.org" target="_blank" rel="noopener">Transitous</a>
        (<a href="https://transitous.org/sources/" target="_blank" rel="noopener">data sources</a>) ·
        traffic by TomTom · parking via Overpass from
        <a href="https://overpass.private.coffee/" target="_blank" rel="noopener">Private.coffee</a>
        (<a href="https://overpass.private.coffee/#privacy" target="_blank" rel="noopener">privacy</a>) and other Overpass servers · map by
        <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>,
        © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors ·
        <a href="https://github.com/thinkaliker/MultiModalNav" target="_blank" rel="noopener">source</a>
      </footer>
    {/if}
  </aside>
</div>

{#if auth === 'signed-out'}
  <Login onsuccess={checkSession} />
{/if}

<style>
  .app {
    height: 100%;
    display: grid;
    grid-template-rows: 40dvh 1fr;
    transition: grid-template-rows 0.2s;
  }
  .app.map-expanded {
    grid-template-rows: 78dvh 1fr;
  }
  .map-wrap {
    position: relative;
    min-height: 0;
  }
  .panel {
    min-height: 0;
    overflow-y: auto;
    padding: 0.8rem 0.9rem calc(1rem + env(safe-area-inset-bottom));
    background: var(--panel);
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  @media (min-width: 820px) {
    .app,
    .app.map-expanded {
      grid-template-rows: 1fr;
      grid-template-columns: 400px 1fr;
    }
    .map-wrap {
      grid-column: 2;
      grid-row: 1;
    }
    .panel {
      grid-column: 1;
      grid-row: 1;
      border-top: 0;
      border-right: 1px solid var(--border);
    }
    .expand {
      display: none;
    }
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  h1 {
    margin: 0;
    font-size: 1.1rem;
    flex: 1;
  }
  .badge {
    font-size: 0.7rem;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    background: #dcfce7;
    color: #166534;
  }
  .badge.off {
    background: #fef3c7;
    color: #92400e;
  }
  .link {
    border: 0;
    background: none;
    color: var(--accent);
    font-size: 0.85rem;
    padding: 0;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .places {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .swap {
    position: absolute;
    right: 5.6rem;
    top: 50%;
    transform: translateY(-40%);
    z-index: 2;
    width: 1.9rem;
    height: 1.9rem;
    border: 1px solid var(--border);
    border-radius: 50%;
    background: #fff;
    font-size: 0.95rem;
  }
  .time {
    display: flex;
    gap: 0.4rem;
  }
  .time select,
  .time input {
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: #fff;
  }
  .time input {
    flex: 1;
    min-width: 0;
  }
  .primary {
    padding: 0.7rem;
    border: 0;
    border-radius: var(--radius);
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .primary:disabled {
    opacity: 0.7;
  }
  .error {
    margin: 0;
    color: var(--danger);
  }
  .note {
    margin: 0;
    font-size: 0.85rem;
    color: #92400e;
    background: #fffbeb;
    border: 1px solid #fde68a;
    border-radius: var(--radius);
    padding: 0.45rem 0.6rem;
  }
  .cost {
    margin: 0;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .estimate {
    margin-top: -0.4rem;
    text-align: center;
  }
  footer {
    margin-top: auto;
    padding-top: 0.75rem;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .pick-hint {
    position: absolute;
    top: 0.6rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.75rem;
    border-radius: 999px;
    background: #0f172a;
    color: #fff;
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .pick-hint button {
    border: 0;
    border-radius: 999px;
    padding: 0.15rem 0.6rem;
    background: #fff;
    color: #0f172a;
  }
  .expand {
    position: absolute;
    bottom: 0.5rem;
    left: 0.5rem;
    z-index: 5;
    padding: 0.3rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: #fff;
    font-size: 0.8rem;
  }
</style>
