<script lang="ts">
  import { app } from '../state.svelte';
  import { haptic } from '../haptics';
  import type { PendingPermission } from '../protocol';
  import { toolSummary } from '../tools';
  import ToolInput from './ToolInput.svelte';

  let { p, cwd }: { p: PendingPermission; cwd?: string } = $props();

  let busy = $state(false);
  // Без связи ответ всё равно не дойдёт: кнопки выключены, баннер объясняет почему.
  const offline = $derived(app.net !== 'ok');
  let denying = $state(false);
  let comment = $state('');
  const summary = $derived(toolSummary(p.toolName, p.input, cwd));
  const hasSuggestions = $derived(Array.isArray(p.suggestions) && p.suggestions.length > 0);

  async function answer(behavior: 'allow' | 'deny', always = false) {
    if (busy) return;
    haptic();
    busy = true;
    try {
      await app.request({
        type: 'answer_permission',
        id: p.id,
        behavior,
        ...(behavior === 'deny' && comment.trim() ? { message: comment.trim() } : {}),
        ...(always && hasSuggestions ? { updatedPermissions: $state.snapshot(p.suggestions) } : {}),
      });
    } catch (e) {
      app.toast((e as Error).message, 'error');
      busy = false;
    }
  }
</script>

<section class="ios-card card" aria-label="Запрос разрешения">
  <header>
    <span class="ios-card-kind">Разрешение</span>
    <span class="ios-card-title">{p.toolName}</span>
  </header>
  {#if summary.detail && p.toolName !== 'Bash' && !['Edit', 'MultiEdit', 'Write'].includes(p.toolName)}
    <p class="detail" class:mono={summary.mono}>{summary.detail}</p>
  {/if}
  <div class="input">
    <ToolInput name={p.toolName} input={p.input} {cwd} />
  </div>

  {#if denying}
    <label class="label" for="deny-{p.id}">Комментарий для Claude (необязательно)</label>
    <textarea id="deny-{p.id}" class="field" rows="2" bind:value={comment} placeholder="Почему отклоняете, что сделать вместо этого"
    ></textarea>
    <div class="btn-row">
      <button class="btn" disabled={busy} onclick={() => (denying = false)}>Назад</button>
      <button class="btn btn-destructive" disabled={busy || offline} onclick={() => answer('deny')}>Отклонить</button>
    </div>
  {:else}
    <button class="btn btn-primary btn-block" disabled={busy || offline} onclick={() => answer('allow')}>Разрешить</button>
    <div class="btn-row">
      {#if hasSuggestions}
        <button class="btn" disabled={busy || offline} onclick={() => answer('allow', true)}
          >Разрешить всегда</button
        >
      {/if}
      <button class="btn btn-destructive" disabled={busy || offline} onclick={() => (denying = true)}>Отклонить</button>
    </div>
  {/if}
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
