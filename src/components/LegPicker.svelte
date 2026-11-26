<script lang="ts">
  import { FIRST_LEG_OPTIONS, isCarFirst, LAST_LEG_OPTIONS, TRANSIT_OPTIONS } from '../lib/modes';
  import type { FirstLeg, LastLeg, TransitChoice, TripSettings } from '../lib/types';

  let { settings = $bindable() }: { settings: TripSettings } = $props();

  /** Toggle `id` in `list`, but never leave the list empty. */
  function toggled<T>(list: T[], id: T): T[] {
    if (!list.includes(id)) return [...list, id];
    return list.length > 1 ? list.filter((x) => x !== id) : list;
  }

  const anyCar = $derived(settings.firstLegs.some(isCarFirst));
  const onlyCar = $derived(settings.firstLegs.every(isCarFirst));
  const anyRideshare = $derived(settings.firstLegs.includes('RIDESHARE') || settings.lastLegs.includes('RIDESHARE'));
  const onlyRideshareLast = $derived(settings.lastLegs.length === 1 && settings.lastLegs[0] === 'RIDESHARE');
</script>

<fieldset>
  <legend>1 · Get to transit <span class="hint">pick one or more</span></legend>
  <div class="chips">
    {#each FIRST_LEG_OPTIONS as opt (opt.id)}
      <button
        type="button"
        class="chip"
        aria-pressed={settings.firstLegs.includes(opt.id)}
        onclick={() => (settings.firstLegs = toggled<FirstLeg>(settings.firstLegs, opt.id))}
      >
        {opt.icon} {opt.label}
      </button>
    {/each}
  </div>
</fieldset>

<fieldset>
  <legend>2 · Transit</legend>
  <div class="chips">
    {#each TRANSIT_OPTIONS as opt (opt.id)}
      <button
        type="button"
        class="chip"
        aria-pressed={settings.transit.includes(opt.id)}
        onclick={() => (settings.transit = toggled<TransitChoice>(settings.transit, opt.id))}
      >
        {opt.icon} {opt.label}
      </button>
    {/each}
  </div>
</fieldset>

<fieldset>
  <legend>3 · From transit <span class="hint">pick one or more</span></legend>
  <div class="chips">
    {#each LAST_LEG_OPTIONS as opt (opt.id)}
      <button
        type="button"
        class="chip"
        aria-pressed={settings.lastLegs.includes(opt.id)}
        onclick={() => (settings.lastLegs = toggled<LastLeg>(settings.lastLegs, opt.id))}
      >
        {opt.icon} {opt.label}
      </button>
    {/each}
  </div>
</fieldset>

<details class="limits">
  <summary>Limits</summary>
  <label>
    <span>Max {onlyCar ? 'drive' : 'first leg'}: {settings.maxFirstLegMin} min</span>
    <input type="range" min="5" max="60" step="5" bind:value={settings.maxFirstLegMin} />
  </label>
  <label>
    <span>Max {onlyRideshareLast ? 'rideshare' : 'last leg'}: {settings.maxLastLegMin} min</span>
    <input type="range" min="5" max="45" step="5" bind:value={settings.maxLastLegMin} />
  </label>
  <label>
    <span>Min stops on transit: {settings.minTransitStops === 1 ? 'any' : settings.minTransitStops}</span>
    <input type="range" min="1" max="8" step="1" bind:value={settings.minTransitStops} />
  </label>
  {#if anyRideshare}
    <label>
      <span>Rideshare pickup wait: {settings.rideshareWaitMin} min</span>
      <input type="range" min="0" max="20" step="1" bind:value={settings.rideshareWaitMin} />
    </label>
  {/if}
  {#if settings.firstLegs.includes('CAR_PARKING')}
    <label>
      <span>Parking + walk to platform: {settings.parkBufferMin} min</span>
      <input type="range" min="0" max="20" step="1" bind:value={settings.parkBufferMin} />
    </label>
  {/if}
  {#if anyCar}
    <label>
      <span>Stations to compare: {settings.stationsToCompare}</span>
      <input type="range" min="2" max="10" step="1" bind:value={settings.stationsToCompare} />
    </label>
  {/if}
</details>

<style>
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
  }
  legend {
    padding: 0;
    margin-bottom: 0.3rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--muted);
  }
  .hint {
    font-weight: 400;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .limits summary {
    font-size: 0.85rem;
    color: var(--muted);
    cursor: pointer;
  }
  .limits label {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    margin-top: 0.5rem;
    font-size: 0.85rem;
  }
</style>
