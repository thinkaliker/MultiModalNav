<script lang="ts">
  import { fmtDistance, fmtDuration, fmtTime, parkingDetail } from '../lib/format';
  import { modeIcon } from '../lib/modes';
  import type { TripOption } from '../lib/types';

  let { option, onback }: { option: TripOption; onback: () => void } = $props();

  const tz = $derived(option.legs.find((l) => l.tz)?.tz);
  const last = $derived(option.legs[option.legs.length - 1]);
</script>

<div class="detail">
  <button type="button" class="back" onclick={onback}>‹ All routes</button>
  <h2>{option.title}</h2>
  <p class="summary">
    {fmtTime(option.startTime, tz)} → {fmtTime(option.endTime, tz)} · {fmtDuration(option.durationSec)}
    {#if option.transfers > 0}· {option.transfers} transfer{option.transfers > 1 ? 's' : ''}{/if}
  </p>

  <ol class="timeline">
    {#each option.legs as leg, i (i)}
      <li style:--leg-color={leg.color} class:dashed={leg.dashed}>
        <div class="time">{fmtTime(leg.startTime, leg.tz ?? tz)}</div>
        <div class="body">
          {#if i === 0 || leg.from.name !== option.legs[i - 1].from.name}
            <div class="place">{leg.from.name}</div>
          {/if}
          <div class="leg">
            <span class="icon">{modeIcon(leg.mode)}</span>
            {#if leg.routeShortName}
              <span class="route" style:background={leg.color} style:color={leg.textColor}>{leg.routeShortName}</span>
              {leg.headsign ? `toward ${leg.headsign}` : ''}
            {:else}
              {leg.label}
            {/if}
          </div>
          <div class="meta">
            {fmtDuration(leg.durationSec)}
            {#if leg.distanceM}· {fmtDistance(leg.distanceM)}{/if}
            {#if leg.stopCount}· {leg.stopCount} stop{leg.stopCount > 1 ? 's' : ''}{/if}
            {#if leg.track}· track {leg.track}{/if}
            {#if leg.agencyName}· {leg.agencyName}{/if}
            {#if leg.realTime}<span class="live">● live</span>{/if}
            {#if leg.cancelled}<span class="cancelled">cancelled</span>{/if}
          </div>
          {#if leg.trafficEstimated}
            <div class="traffic">Estimated time (no traffic data)</div>
          {:else if leg.trafficDelaySec !== undefined && leg.trafficDelaySec >= 60}
            <div class="traffic warn">Includes {fmtDuration(leg.trafficDelaySec)} of traffic delay</div>
          {/if}
          {#if leg.mode === 'PARK' && option.parking}
            <div class="parking">🅿️ {parkingDetail(option.parking)} <span class="credit">(OpenStreetMap)</span></div>
          {/if}
          {#each leg.alerts ?? [] as alert}
            <div class="alert">⚠️ {alert}</div>
          {/each}
        </div>
      </li>
    {/each}
    <li class="end">
      <div class="time">{fmtTime(last.endTime, last.tz ?? tz)}</div>
      <div class="body"><div class="place">{last.to.name}</div></div>
    </li>
  </ol>

  {#if option.alternatives.length}
    <h3>Other departures{option.station ? ` from ${option.station.name}` : ''}</h3>
    <ul class="alternatives">
      {#each option.alternatives as alt (alt.startTime + alt.endTime)}
        <li class="chip">Leave {fmtTime(alt.startTime, tz)} → {fmtTime(alt.endTime, tz)}</li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .back {
    border: 0;
    background: none;
    padding: 0;
    color: var(--accent);
    font-weight: 600;
  }
  h2 {
    margin: 0.5rem 0 0.2rem;
    font-size: 1.15rem;
  }
  .summary {
    margin: 0 0 1rem;
    color: var(--muted);
  }
  .timeline {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .timeline li {
    display: grid;
    grid-template-columns: 4.2rem 1fr;
    gap: 0.6rem;
  }
  .time {
    font-weight: 600;
    font-size: 0.85rem;
    padding-top: 0.05rem;
  }
  .body {
    border-left: 4px solid var(--leg-color, #94a3b8);
    padding: 0 0 1rem 0.7rem;
  }
  li.dashed .body {
    border-left-style: dotted;
  }
  li.end .body {
    border-left-color: transparent;
    padding-bottom: 0;
  }
  .place {
    font-weight: 600;
  }
  .leg {
    margin-top: 0.3rem;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .route {
    padding: 0.05rem 0.4rem;
    border-radius: 5px;
    font-weight: 700;
    font-size: 0.85rem;
  }
  .meta,
  .traffic,
  .parking {
    font-size: 0.85rem;
    color: var(--muted);
    margin-top: 0.15rem;
  }
  .credit {
    font-size: 0.75rem;
  }
  .traffic.warn {
    color: #b45309;
  }
  .live {
    color: #16a34a;
    margin-left: 0.3rem;
  }
  .cancelled {
    color: var(--danger);
    font-weight: 600;
    margin-left: 0.3rem;
  }
  .alert {
    font-size: 0.85rem;
    margin-top: 0.3rem;
  }
  h3 {
    font-size: 0.9rem;
    margin: 1rem 0 0.4rem;
  }
  .alternatives {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
</style>
