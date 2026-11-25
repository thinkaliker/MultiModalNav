<script lang="ts">
  import { modeIcon } from '../lib/modes';
  import type { DisplayLeg } from '../lib/types';

  let { legs }: { legs: DisplayLeg[] } = $props();

  // Hide trivial transfers so the summary stays readable.
  const shown = $derived(legs.filter((l) => l.routeShortName || l.durationSec >= 90));
</script>

<div class="legs">
  {#each shown as leg, i (i)}
    {#if i > 0}<span class="sep">›</span>{/if}
    {#if leg.routeShortName}
      <span class="leg transit" style:background={leg.color} style:color={leg.textColor}>
        {modeIcon(leg.mode)} {leg.routeShortName}
      </span>
    {:else}
      <span class="leg">{modeIcon(leg.mode)} {Math.round(leg.durationSec / 60)}</span>
    {/if}
  {/each}
</div>

<style>
  .legs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.8rem;
  }
  .leg {
    padding: 0.1rem 0.35rem;
    border-radius: 6px;
    background: #f1f5f9;
    white-space: nowrap;
  }
  .leg.transit {
    font-weight: 600;
  }
  .sep {
    color: var(--muted);
  }
</style>
