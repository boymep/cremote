<script lang="ts">
  import { app } from '../state.svelte';
  import { haptic } from '../haptics';
  import type { PendingPermission } from '../protocol';
  import { toolSummary } from '../tools';
  import ToolInput from './ToolInput.svelte';

  let { p, cwd }: { p: PendingPermission; cwd?: string } = $props();

  let busy = $state(false);
  const offline = $derived(app.net !== 'ok');
  const summary = $derived(toolSummary(p.toolName, p.input, cwd));

  async function answer(behavior: 'allow' | 'deny') {
    if (busy) return;
    haptic();
    busy = true;
    try {
      await app.request({ type: 'answer_permission', id: p.id, behavior });
    } catch (e) {
      app.toast((e as Error).message, 'error');
      busy = false;
    }
  }
</script>

<section class="ios-card card" aria-label="Заблокировано классификатором">
  <header>
    <span class="ios-card-kind">Заблокировано классификатором</span>
    <span class="ios-card-title">{p.toolName}</span>
  </header>
  {#if p.reason}
    <p class="detail">{p.reason}</p>
  {/if}
  {#if summary.detail && p.toolName !== 'Bash' && !['Edit', 'MultiEdit', 'Write'].includes(p.toolName)}
    <p class="detail" class:mono={summary.mono}>{summary.detail}</p>
  {/if}
  <div class="input">
    <ToolInput name={p.toolName} input={p.input} {cwd} />
  </div>
  <button class="btn btn-primary btn-block" disabled={busy || offline} onclick={() => answer('allow')}>Разрешить</button>
  <div class="btn-row">
    <button class="btn btn-destructive" disabled={busy || offline} onclick={() => answer('deny')}>Отклонить</button>
  </div>
</section>

<style>
  header {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .detail {
    margin: 0;
    font: var(--t-subhead);
    color: var(--fg-muted);
    overflow-wrap: anywhere;
  }
  .input {
    min-width: 0;
    max-height: round(down, 32vh, 4px);
    overflow: auto;
    overscroll-behavior: contain;
  }
</style>
