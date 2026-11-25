<script lang="ts">
  import { FIRST_LEG_OPTIONS, isCarFirst, LAST_LEG_OPTIONS, TRANSIT_OPTIONS } from '../lib/modes';
  import type { TransitChoice, TripSettings } from '../lib/types';

  let { settings = $bindable() }: { settings: TripSettings } = $props();

  function toggleTransit(id: TransitChoice) {
    settings.transit = settings.transit.includes(id)
      ? settings.transit.filter((t) => t !== id)
      : [...settings.transit, id];
  }
</script>

<fieldset>
  <legend>1 · Get to transit</legend>
  <div class="chips">
    {#each FIRST_LEG_OPTIONS as opt (opt.id)}
      <button type="button" class="chip" aria-pressed={settings.firstLeg === opt.id} onclick={() => (settings.firstLeg = opt.id)}>
        {opt.icon} {opt.label}
      </button>
    {/each}
  </div>
</fieldset>

<fieldset>
  <legend>2 · Transit</legend>
  <div class="chips">
    {#each TRANSIT_OPTIONS as opt (opt.id)}
      <button type="button" class="chip" aria-pressed={settings.transit.includes(opt.id)} onclick={() => toggleTransit(opt.id)}>
        {opt.icon} {opt.label}
      </button>
    {/each}
  </div>
</fieldset>

<fieldset>
  <legend>3 · From transit</legend>
  <div class="chips">
    {#each LAST_LEG_OPTIONS as opt (opt.id)}
      <button type="button" class="chip" aria-pressed={settings.lastLeg === opt.id} onclick={() => (settings.lastLeg = opt.id)}>
        {opt.icon} {opt.label}
      </button>
    {/each}
  </div>
</fieldset>

<details class="limits">
  <summary>Limits</summary>
  <label>
    <span>Max {isCarFirst(settings.firstLeg) ? 'drive' : 'first leg'}: {settings.maxFirstLegMin} min</span>
    <input type="range" min="5" max="60" step="5" bind:value={settings.maxFirstLegMin} />
  </label>
  <label>
    <span>Max last leg: {settings.maxLastLegMin} min</span>
    <input type="range" min="5" max="45" step="5" bind:value={settings.maxLastLegMin} />
  </label>
  {#if isCarFirst(settings.firstLeg)}
    {#if settings.firstLeg === 'CAR_PARKING'}
      <label>
        <span>Parking + walk to platform: {settings.parkBufferMin} min</span>
        <input type="range" min="0" max="20" step="1" bind:value={settings.parkBufferMin} />
      </label>
    {/if}
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
