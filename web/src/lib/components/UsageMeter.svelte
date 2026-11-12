<script lang="ts">
  import { app } from '../state.svelte';
  import type { AccountWindow } from '../protocol';
  import { LEVEL_WORD, resetClock, resetIn, resetShort, usageLevel, windowShort } from '../format';

  // Одна строка: подпись · полоса · процент [слово уровня] · сброс.
  let { w }: { w: AccountWindow } = $props();

  const raw = $derived(Math.round(w.pct));
  const pct = $derived(Math.max(0, Math.min(100, raw)));
  const level = $derived(usageLevel(raw));
  const word = $derived(LEVEL_WORD[level]);
  const label = $derived(windowShort(w.id, w.label));
  const full = $derived(w.resetsAt ? `сброс ${resetIn(w.resetsAt, app.now)} · ${resetClock(w.resetsAt, app.now)}` : '');
  const short = $derived(w.resetsAt ? resetShort(w.resetsAt, app.now) : '');
  const aria = $derived(`${w.label}: ${level === 'exhausted' ? 'исчерпан' : `израсходовано ${pct} %`}${word && level !== 'exhausted' ? `, ${word} исчерпан` : ''}${full ? `, ${full}` : ''}`);
</script>

<div class="meter {level}" title={full || undefined} role="group" aria-label={aria}>
  <span class="label" aria-hidden="true">{label}</span>
  <span class="bar" aria-hidden="true"><span class="fill" style:width="{pct}%"></span></span>
  {#if level === 'exhausted'}
    <span class="word" aria-hidden="true">{word}</span>
  {:else}
    <span class="pct" aria-hidden="true">{pct}&nbsp;%{#if word}<span class="word gap">{word}</span>{/if}</span>
  {/if}
  <span class="reset" aria-hidden="true">{level === 'exhausted' && short ? `сброс ${short}` : short}</span>
</div>

<style>
  .meter {
    --c: var(--ok);
    display: grid;
    /* Фиксированные колонки: полосы одинаковой длины во всех строках. */
    grid-template-columns: 30px minmax(32px, 1fr) 5.8em 7.6em;
    align-items: center;
    gap: 8px;
    min-height: 24px;
    min-width: 0;
    font: var(--t-footnote);
  }
  .warning {
    --c: var(--warn);
  }
  .danger,
  .exhausted {
    --c: var(--danger);
  }
  .label {
    color: var(--fg-muted);
    white-space: nowrap;
  }
  .bar {
    position: relative;
    height: 6px;
    border-radius: 3px;
    background: var(--bg-sunken);
    box-shadow: inset 0 0 0 1px var(--border);
    overflow: hidden;
  }
  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--c);
    border-radius: inherit;
  }
  .pct {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    text-align: right;
  }
  .warning .pct,
  .danger .pct {
    color: var(--c);
  }
  .word.gap {
    margin-left: 0.3em;
  }
  .word {
    font-weight: 600;
    text-align: right;
    color: var(--c);
    white-space: nowrap;
  }
  .reset {
    color: var(--fg-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  /* Лимит исчерпан: главное — когда он вернётся. */
  .exhausted .reset {
    color: var(--fg);
    font-weight: var(--w-semibold);
  }
</style>
