<script lang="ts">
  import { app } from '../state.svelte';

  function open(id: number, sessionId?: string) {
    app.dismissToast(id);
    if (sessionId) app.navigate({ name: 'session', id: sessionId });
  }
</script>

<div class="toasts" aria-live="polite">
  {#each app.toasts as t (t.id)}
    <button class="toast" class:error={t.tone === 'error'} onclick={() => open(t.id, t.sessionId)}>
      {t.text}
    </button>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    top: calc(var(--s-2) + var(--safe-top));
    left: calc(var(--gutter) + var(--safe-left));
    right: calc(var(--gutter) + var(--safe-right));
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    z-index: 100;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    max-width: 560px;
    width: 100%;
    margin: 0 auto;
    text-align: left;
    padding: var(--s-3) var(--s-4);
    border: 0;
    border-radius: var(--radius-group);
    background: var(--bar-bg);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    backdrop-filter: saturate(180%) blur(20px);
    box-shadow: 0 0 0 0.5px var(--border), 0 8px 30px rgb(0 0 0 / 0.2);
    font: var(--t-subhead);
    overflow-wrap: anywhere;
    cursor: pointer;
  }
  .toast.error {
    box-shadow: inset 4px 0 0 var(--danger), 0 0 0 0.5px var(--border), 0 8px 30px rgb(0 0 0 / 0.2);
    color: var(--fg);
  }
</style>
