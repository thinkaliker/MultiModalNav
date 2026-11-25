<script lang="ts">
  import type { UsageMeter, UsageReport } from '../lib/types';

  let { report }: { report: UsageReport | null } = $props();

  const fmt = (n: number) => n.toLocaleString();
  const level = (m: UsageMeter) => (m.used >= m.limit ? 'over' : m.used >= m.limit * 0.8 ? 'near' : '');
</script>

{#snippet meter(label: string, unit: string, m: UsageMeter)}
  <span class={level(m)} title={`${m.window === 'month' ? 'Month' : 'Day'} ${m.period} (UTC)`}>
    {label} {fmt(m.used)} / {fmt(m.limit)} {unit} {m.window === 'month' ? 'this month' : 'today'}
  </span>
{/snippet}

{#if report}
  <p class="usage">
    {#if report.tracking && report['tomtom.route'] && report['transitous.plan']}
      Usage: {@render meter('TomTom', 'routes', report['tomtom.route'])} ·
      {@render meter('Transitous', 'queries', report['transitous.plan'])}
    {:else}
      Usage tracking is off (no USAGE_DB database bound).
    {/if}
  </p>
{/if}

<style>
  .usage {
    margin: 0 0 0.35rem;
  }
  .near {
    color: #b45309;
    font-weight: 600;
  }
  .over {
    color: var(--danger);
    font-weight: 600;
  }
</style>
