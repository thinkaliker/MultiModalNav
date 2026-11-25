<script lang="ts">
  import { fmtDuration, fmtTime } from '../lib/format';
  import type { TripOption } from '../lib/types';
  import LegChips from './LegChips.svelte';

  interface Props {
    options: TripOption[];
    direct: TripOption[];
    selectedId: string | null;
    onselect: (id: string) => void;
    onopen: (id: string) => void;
  }

  let { options, direct, selectedId, onselect, onopen }: Props = $props();

  const tzOf = (opt: TripOption) => opt.legs.find((l) => l.tz)?.tz;
</script>

{#snippet card(opt: TripOption, index: number | null)}
  <li class:selected={opt.id === selectedId}>
    <button type="button" class="card" onclick={() => (opt.id === selectedId ? onopen(opt.id) : onselect(opt.id))}>
      <div class="top">
        {#if index !== null}<span class="rank">{index + 1}</span>{/if}
        <span class="title">{opt.title}</span>
        <span class="duration">{fmtDuration(opt.durationSec)}</span>
      </div>
      <div class="times">
        {fmtTime(opt.startTime, tzOf(opt))} → {fmtTime(opt.endTime, tzOf(opt))}
        {#if opt.transfers > 0}· {opt.transfers} transfer{opt.transfers > 1 ? 's' : ''}{/if}
        {#if opt.realTime}<span class="live" title="Includes live transit data">● live</span>{/if}
      </div>
      <LegChips legs={opt.legs} />
      {#if opt.traffic}
        <div class="traffic" class:warn={opt.traffic.delaySec >= 300}>
          {#if opt.traffic.estimated}
            {opt.traffic.label} ~{fmtDuration(opt.traffic.driveSec)} (estimate, no traffic data)
          {:else}
            {opt.traffic.label} {fmtDuration(opt.traffic.driveSec)}{opt.traffic.delaySec >= 60 ? ` incl. ${fmtDuration(opt.traffic.delaySec)} traffic delay` : ', light traffic'}
          {/if}
        </div>
      {/if}
    </button>
    <button type="button" class="details" onclick={() => onopen(opt.id)} aria-label="Show details">›</button>
  </li>
{/snippet}

{#if options.length}
  <ol class="results">
    {#each options as opt, i (opt.id)}
      {@render card(opt, i)}
    {/each}
  </ol>
{/if}

{#if direct.length}
  <h3>For comparison</h3>
  <ol class="results">
    {#each direct as opt (opt.id)}
      {@render card(opt, null)}
    {/each}
  </ol>
{/if}

<style>
  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  li {
    display: flex;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: #fff;
    overflow: hidden;
  }
  li.selected {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .card {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.6rem 0.7rem;
    border: 0;
    background: none;
    text-align: left;
  }
  .details {
    flex: none;
    width: 2.2rem;
    border: 0;
    border-left: 1px solid var(--border);
    background: #f8fafc;
    font-size: 1.3rem;
    color: var(--muted);
  }
  .top {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
  }
  .rank {
    flex: none;
    min-width: 1.3rem;
    height: 1.3rem;
    border-radius: 50%;
    background: #334155;
    color: #fff;
    font-size: 0.75rem;
    font-weight: 700;
    line-height: 1.3rem;
    text-align: center;
  }
  li.selected .rank {
    background: var(--accent);
  }
  .title {
    flex: 1;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .duration {
    font-weight: 700;
  }
  .times,
  .traffic {
    font-size: 0.85rem;
    color: var(--muted);
  }
  .traffic.warn {
    color: #b45309;
  }
  .live {
    color: #16a34a;
    margin-left: 0.3rem;
  }
  h3 {
    margin: 1rem 0 0.4rem;
    font-size: 0.8rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
</style>
