<script lang="ts">
  import { app } from '../state.svelte';
  import { haptic } from '../haptics';

  let confirming = $state(false);

  const u = $derived(app.update);
  const show = $derived(!!u && u.available && u.autoUpdate !== 'off' && u.canUpdate);

  function go() {
    haptic();
    confirming = false;
    void app.runUpdate();
  }
</script>

{#if show && u}
  {#if confirming}
    <div class="ios-confirm">
      <span class="ios-confirm-q center">Сервер перезапустится, сессии, запущенные с телефона, прервутся. Обновить?</span>
      <span class="btn-row">
        <button class="btn btn-tint" type="button" onclick={() => (confirming = false)}>Отмена</button>
        <button class="btn btn-tint" type="button" onclick={go}>Обновить</button>
      </span>
    </div>
  {:else}
    <div class="banner" role="status" aria-live="polite">
      <span class="text">
        {#if app.updatingTo}
          <span class="main">Обновляю…</span>
        {:else}
          <span class="main">Доступна версия {u.latest}</span>
        {/if}
      </span>
      {#if !app.updatingTo}
        <button class="act" type="button" onclick={() => (confirming = true)}>Обновить</button>
      {/if}
    </div>
  {/if}
{/if}

<style>
  .banner {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--s-2);
    height: var(--tap);
    padding: 0 calc(var(--gutter) + var(--safe-right)) 0 calc(var(--gutter) + var(--safe-left));
    font: var(--t-subhead);
    background: var(--bg-sunken);
    color: var(--fg);
  }
  .text {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .main {
    font-weight: var(--w-semibold);
  }
  .act {
    flex: none;
    position: relative;
    height: var(--s-8);
    padding: 0 var(--s-3);
    border-radius: var(--radius-full);
    border: 0;
    background: var(--fill);
    color: var(--accent);
    font: var(--t-footnote);
    font-weight: var(--w-semibold);
    cursor: pointer;
  }
  .act::after {
    content: '';
    position: absolute;
    inset: -6px 0;
  }
</style>
