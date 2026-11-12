<script lang="ts">
  // Одна строка на главном экране: активный аккаунт и лимиты «5ч 94% · 7д 16%». Нажатие — настройки.
  import { app, routeHref } from '../state.svelte';
  import { accountName, hasUsage, isActiveAccount, miniWindow } from '../accounts';

  const acc = $derived(app.accounts);
  const active = $derived(acc?.items.find((a) => isActiveAccount(a, acc)));
  const minis = $derived(active && hasUsage(active) ? active.windows.map(miniWindow) : []);
</script>

{#if acc}
  <section class="ios-section summary">
    <div class="ios-list">
      <a class="ios-cell" href={routeHref({ name: 'settings' })} aria-label="Аккаунт и настройки">
        <span class="ios-avatar" aria-hidden="true">{(active ? accountName(active) : '?').slice(0, 1).toUpperCase()}</span>
        <span class="line">
          <span class="ios-cell-title name">{active ? accountName(active) : 'Аккаунт не определён'}</span>
          {#if minis.length > 0}
            <span class="limits">
              {#each minis as m, i (m.short)}
                {#if i > 0}<span class="ios-sep" aria-hidden="true">·</span>{/if}
                <span class="lim {m.level}"><span class="k">{m.short}</span> {m.text}</span>
              {/each}
            </span>
          {/if}
        </span>
        <span class="ios-chevron" aria-hidden="true"></span>
      </a>
    </div>
  </section>
{/if}

<style>
  /* Имя и лимиты разного размера стоят на одной базовой линии. */
  .line {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: var(--s-3);
    height: var(--s-6);
  }
  .name {
    flex: 1;
  }
  .limits {
    flex: none;
    display: flex;
    align-items: baseline;
    gap: var(--s-1);
    font: var(--t-subhead);
    font-variant-numeric: tabular-nums;
    color: var(--fg-muted);
    white-space: nowrap;
  }
  .k {
    color: var(--fg-muted);
  }
  .lim {
    color: var(--fg);
  }
  .lim.warning {
    color: var(--warn);
  }
  .lim.danger,
  .lim.exhausted {
    color: var(--danger);
    font-weight: var(--w-semibold);
  }
  .lim.danger .k,
  .lim.exhausted .k,
  .lim.warning .k {
    color: inherit;
    opacity: 0.8;
  }
</style>
