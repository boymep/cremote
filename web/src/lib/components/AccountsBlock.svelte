<script lang="ts">
  // Раздел «Аккаунт» в настройках: активный аккаунт с лимитами и переключение на другие (cswap).
  import { app } from '../state.svelte';
  import { haptic } from '../haptics';
  import type { AccountItem, AccountWindow } from '../protocol';
  import { relativeTime, resetClock, resetIn, usageLevel } from '../format';
  import {
    accountHeadline,
    accountName,
    accountSecondary,
    hasUsage,
    isActiveAccount,
    loginNote,
    miniWindow,
    usageNote,
  } from '../accounts';

  const NOTE_MS = 60_000;

  /** Номер аккаунта, для которого открыто подтверждение. */
  let confirming = $state<number | null>(null);
  let showSwitchNote = $state(false);

  const acc = $derived(app.accounts);
  const active = $derived(acc?.items.find((a) => isActiveAccount(a, acc)));
  const others = $derived(acc?.items.filter((a) => a !== active) ?? []);
  const busy = $derived(app.switchingAccount !== null);
  const online = $derived(app.net === 'ok');

  // Подсказка про VS Code висит минуту после успешного переключения.
  $effect(() => {
    const at = app.lastSwitchAt;
    if (at == null) return;
    const left = at + NOTE_MS - Date.now();
    if (left <= 0) return;
    showSwitchNote = true;
    const t = setTimeout(() => (showSwitchNote = false), left);
    return () => clearTimeout(t);
  });

  function meter(w: AccountWindow) {
    const raw = Math.round(w.pct);
    const level = usageLevel(raw);
    const pct = Math.max(0, Math.min(100, raw));
    const label = w.id === 'fiveHour' ? '5 часов' : w.id === 'sevenDay' ? '7 дней' : w.label;
    // ≥100 — «исчерпан», иначе процент; уровень показывает цвет.
    const value = level === 'exhausted' ? 'исчерпан' : `${pct} %`;
    const reset = w.resetsAt ? `Сброс ${resetIn(w.resetsAt, app.now)} · ${resetClock(w.resetsAt, app.now)}` : '';
    return { label, pct, level, value, reset };
  }

  function toggleConfirm(a: AccountItem) {
    if (a.number === null || busy || !online) return;
    confirming = confirming === a.number ? null : a.number;
  }

  function doSwitch(a: AccountItem) {
    if (a.number === null) return;
    confirming = null;
    haptic();
    void app.switchAccount(a.number);
  }
</script>

{#if acc}
  <section class="ios-section" aria-labelledby="acc-h">
    <h2 class="ios-section-header" id="acc-h">Аккаунт</h2>
    <ul class="ios-list">
      <li>
        <div class="ios-cell">
          <span class="ios-avatar" aria-hidden="true">{(active ? accountName(active) : '?').slice(0, 1).toUpperCase()}</span>
          <span class="ios-cell-body">
            {#if active}
              <span class="ios-cell-title strong" title={accountHeadline(active)}>{accountName(active)}</span>
              {#if accountSecondary(active) || (active.org && active.org !== accountName(active))}
                <span class="ios-cell-sub">{accountHeadline(active).slice(accountName(active).length + 3)}</span>
              {/if}
            {:else}
              <span class="ios-cell-title muted">Активный аккаунт не определён</span>
            {/if}
          </span>
          {#if active?.disabled}<span class="ios-cell-value">вне ротации</span>{/if}
        </div>
      </li>
      {#if active}
        {#if hasUsage(active)}
          {#each active.windows as w (w.id)}
            {@const m = meter(w)}
            <li>
              <div class="ios-cell meter {m.level}" role="group" aria-label="{w.label}: {m.value}{m.reset ? `, ${m.reset}` : ''}">
                <span class="mrow" aria-hidden="true">
                  <span class="mlabel">{m.label}</span>
                  <span class="mvalue">{m.value}</span>
                </span>
                <span class="bar" aria-hidden="true"><span class="fill" style:width="{m.pct}%"></span></span>
                {#if m.reset}<span class="mreset" aria-hidden="true">{m.reset}</span>{/if}
              </div>
            </li>
          {/each}
        {:else}
          <li><div class="ios-cell"><span class="muted note">{usageNote(active)}</span></div></li>
        {/if}
        {#if loginNote(active, app.now)}
          <li><div class="ios-cell"><span class="note warn">{loginNote(active, app.now)}</span></div></li>
        {/if}
      {/if}
      <li>
        <button
          class="ios-cell tint"
          type="button"
          disabled={app.refreshingAccounts || !online}
          onclick={() => app.refreshAccounts()}
        >
          <span class="ios-cell-body">Обновить лимиты</span>
          {#if app.refreshingAccounts}<span class="ios-spinner" aria-hidden="true"></span>{/if}
        </button>
      </li>
    </ul>
    <p class="ios-section-footer">
      Обновлено {relativeTime(acc.fetchedAt, app.now)}.{#if acc.error}<br /><span class="warn">{acc.error}</span>{/if}
    </p>
  </section>

  {#if others.length > 0}
    <section class="ios-section" aria-labelledby="acc-o">
      <h2 class="ios-section-header" id="acc-o">Другие аккаунты</h2>
      <ul class="ios-list">
        {#each others as a, i (a.number ?? `x${i}`)}
          {@const switching = a.number !== null && app.switchingAccount === a.number}
          {@const note = [a.disabled ? 'вне ротации' : '', loginNote(a, app.now)].filter(Boolean).join(' · ')}
          <li class:dim={a.disabled}>
            <button
              class="ios-cell"
              type="button"
              disabled={a.number === null || busy || !online}
              aria-expanded={confirming === a.number}
              aria-busy={switching}
              onclick={() => toggleConfirm(a)}
            >
              <span class="ios-cell-body">
                <span class="ios-cell-title" title={accountHeadline(a)}>{accountName(a)}</span>
                {#if switching}
                  <span class="ios-cell-sub busy">Переключаю…</span>
                {:else if accountSecondary(a) || note}
                  <span class="ios-cell-sub">{[accountSecondary(a), note].filter(Boolean).join(' · ')}</span>
                {/if}
              </span>
              {#if switching}
                <span class="ios-spinner" aria-hidden="true"></span>
              {:else if hasUsage(a)}
                <span class="minis">
                  {#each a.windows.map(miniWindow) as m (m.short)}
                    <span class="mini {m.level}"><span class="k">{m.short}</span> {m.text}</span>
                  {/each}
                </span>
              {:else}
                <span class="ios-cell-value">нет данных</span>
              {/if}
            </button>
            {#if confirming === a.number && !busy}
              <div class="ios-confirm top0" role="group" aria-label="Подтверждение переключения">
                <span class="ios-confirm-q">Переключить на «{accountName(a)}»?</span>
                <span class="btn-row">
                  <button class="btn btn-tint" type="button" onclick={() => (confirming = null)}>Отмена</button>
                  <button class="btn btn-primary" type="button" disabled={!online} onclick={() => doSwitch(a)}>
                    Переключить
                  </button>
                </span>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
      <p class="ios-section-footer">
        {showSwitchNote
          ? 'VS Code подхватит аккаунт примерно за 30 секунд.'
          : 'Нажмите на аккаунт, чтобы переключиться через cswap.'}
      </p>
    </section>
  {/if}
{/if}

<style>
  .strong {
    font-weight: var(--w-semibold);
  }
  .note {
    font: var(--t-subhead);
  }
  .warn {
    color: var(--warn);
  }
  .meter {
    --c: var(--ok);
    flex-direction: column;
    align-items: stretch;
    gap: var(--s-1);
  }
  .meter.warning {
    --c: var(--warn);
  }
  .meter.danger,
  .meter.exhausted {
    --c: var(--danger);
  }
  .mrow {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s-3);
  }
  .mvalue {
    flex: none;
    font-weight: var(--w-semibold);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .warning .mvalue,
  .danger .mvalue,
  .exhausted .mvalue {
    color: var(--c);
  }
  .bar {
    position: relative;
    height: var(--s-2);
    border-radius: var(--radius-full);
    background: var(--fill);
    overflow: hidden;
  }
  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--c);
    border-radius: inherit;
  }
  .mreset {
    font: var(--t-footnote);
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
  }
  .exhausted .mreset {
    color: var(--fg);
    font-weight: var(--w-semibold);
  }
  .dim .ios-cell-title {
    color: var(--fg-muted);
  }
  .busy {
    color: var(--accent);
  }
  /* Два лимита столбиком на линиях заголовка (24) и подписи (20): поле 4 + 20 + 20. */
  .minis {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    padding-top: var(--s-1);
    font: var(--t-footnote);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .mini .k {
    color: var(--fg-muted);
  }
  .mini.warning {
    color: var(--warn);
  }
  .mini.danger,
  .mini.exhausted {
    color: var(--danger);
    font-weight: var(--w-semibold);
  }
  /* Подтверждение идёт сразу под своей ячейкой. */
  .top0 {
    padding-top: 0;
  }
</style>
