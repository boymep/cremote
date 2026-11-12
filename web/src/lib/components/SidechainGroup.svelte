<script lang="ts">
  import type { Message, ToolResultBlock } from '../protocol';
  import MessageView from './MessageView.svelte';

  interface Props {
    messages: Message[];
    results: Map<string, ToolResultBlock>;
    toolUseIds: Set<string>;
    cwd?: string;
    sessionId?: string;
  }
  let { messages, results, toolUseIds, cwd, sessionId }: Props = $props();
  let open = $state(false);

  const toolCount = $derived(messages.reduce((n, m) => n + m.blocks.filter((b) => b.kind === 'tool_use').length, 0));
  const firstText = $derived.by(() => {
    for (const m of messages) for (const b of m.blocks) if (b.kind === 'text') return b.text.replace(/\s+/g, ' ');
    return '';
  });
</script>

<div class="group">
  <button class="sum" type="button" aria-expanded={open} onclick={() => (open = !open)}>
    <svg class="ios-icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"
      ><circle cx="12" cy="8" r="4" /><path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5" /></svg
    >
    <span class="line">
      <span class="label">Сабагент</span>
      <span class="count">{messages.length} сообщ. · {toolCount} инстр.</span>
      {#if !open && firstText}<span class="preview">{firstText}</span>{/if}
    </span>
  </button>
  {#if open}
    <div class="body">
      {#each messages as m (m.uuid)}
        <MessageView message={m} {results} {toolUseIds} {cwd} {sessionId} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .group {
    border-radius: var(--radius-nested);
    background: var(--bg-elev);
    min-width: 0;
  }
  .sum {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    width: 100%;
    min-height: var(--tap);
    padding: var(--s-2) var(--s-3);
    background: none;
    border: 0;
    text-align: left;
    font: var(--t-subhead);
    color: var(--fg-muted);
    cursor: pointer;
  }
  .line {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: var(--s-2);
    height: 20px;
  }
  .label {
    flex: none;
    font-weight: var(--w-semibold);
    color: var(--fg);
  }
  .count {
    flex: none;
    font: var(--t-footnote);
  }
  .preview {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-faint);
  }
  /* Вложенные строки контрастнее подложки группы. */
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    padding: var(--s-2) var(--s-3) var(--s-3);
    box-shadow: inset 0 0.5px 0 var(--border);
  }
  .body :global(.sum),
  .body :global(.md pre) {
    background: var(--bg-sunken);
  }
</style>
