<script lang="ts">
  import type { Message, ToolResultBlock } from '../protocol';
  import Markdown from './Markdown.svelte';
  import ToolCall from './ToolCall.svelte';
  import Thinking from './Thinking.svelte';
  import SystemRow from './SystemRow.svelte';

  interface Props {
    message: Message;
    results: Map<string, ToolResultBlock>;
    /** id вызовов, которые есть в ленте: их результаты показываются под вызовом. */
    toolUseIds: Set<string>;
    cwd?: string;
    sessionId?: string;
  }
  let { message, results, toolUseIds, cwd, sessionId }: Props = $props();

  const isUser = $derived(message.role === 'user');

  function imgSrc(mediaType: string, data: string): string | null {
    if (!data || !/^image\/[\w.+-]+$/.test(mediaType)) return null;
    if (!/^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 200))) return null;
    return `data:${mediaType};base64,${data}`;
  }
</script>

<div class="msg" class:user={isUser}>
  {#each message.blocks as b, i (i)}
    {#if b.kind === 'text'}
      {#if isUser}
        <div class="bubble"><Markdown text={b.text} {cwd} {sessionId} /></div>
      {:else}
        <div class="text"><Markdown text={b.text} {cwd} {sessionId} /></div>
      {/if}
    {:else if b.kind === 'thinking'}
      <Thinking text={b.text} />
    {:else if b.kind === 'image'}
      {@const src = imgSrc(b.mediaType, b.data)}
      {#if src}
        <img class="img" {src} alt="Вложение" loading="lazy" />
      {:else}
        <div class="img-ph">Картинка ({b.mediaType}) не показана</div>
      {/if}
    {:else if b.kind === 'tool_use'}
      <ToolCall block={b} result={results.get(b.id)} {cwd} {sessionId} />
    {:else if b.kind === 'tool_result'}
      {#if !toolUseIds.has(b.toolUseId)}
        <!-- Результат без своего вызова: вызов вне загруженной части ленты. -->
        <pre class="orphan" class:err={b.isError}>{b.text}</pre>
      {/if}
    {:else if b.kind === 'hook_feedback'}
      <div class="bubble remote">
        <span class="via">с телефона</span>
        <Markdown text={b.text} {cwd} {sessionId} />
      </div>
    {:else if b.kind === 'meta'}
      <SystemRow block={b} />
    {/if}
  {/each}
</div>

<style>
  .msg {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    min-width: 0;
    max-width: 100%;
  }
  /* Ответ Claude — во всю ширину, без пузыря, как в приложении Claude. */
  .text {
    min-width: 0;
    max-width: 100%;
  }
  /* Сообщение пользователя — пузырь акцентного цвета справа, как в iMessage. */
  .bubble {
    align-self: flex-end;
    max-width: min(82%, 560px);
    min-width: 0;
    padding: var(--s-2) var(--s-4);
    border-radius: var(--radius-bubble) var(--radius-bubble) var(--radius-tail) var(--radius-bubble);
    background: var(--accent);
    color: var(--accent-fg);
  }
  .bubble :global(.md a) {
    color: inherit;
    text-decoration: underline;
  }
  .bubble :global(.md code) {
    background: rgb(255 255 255 / 0.2);
  }
  .bubble :global(.md pre) {
    background: rgb(0 0 0 / 0.18);
    color: inherit;
  }
  .bubble.remote {
    background: color-mix(in srgb, var(--accent) 82%, var(--bg));
  }
  .via {
    display: block;
    font: var(--t-caption);
    font-weight: var(--w-semibold);
    opacity: 0.75;
  }
  .img {
    max-width: min(70%, 280px);
    max-height: 320px;
    border-radius: var(--radius-nested);
    object-fit: contain;
    align-self: flex-start;
  }
  .user .img {
    align-self: flex-end;
  }
  .img-ph {
    font: var(--t-subhead);
    color: var(--fg-muted);
    padding: var(--s-2) var(--s-3);
    border-radius: var(--radius-nested);
    background: var(--bg-elev);
  }
  .user .img-ph {
    align-self: flex-end;
  }
  .orphan {
    margin: 0;
    padding: var(--s-2) var(--s-3);
    border-radius: var(--radius-nested);
    background: var(--bg-elev);
    color: var(--fg-muted);
    font: var(--t-mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: round(down, 30vh, 4px);
    overflow: auto;
  }
  .orphan.err {
    background: var(--danger-soft);
    color: var(--fg);
  }
</style>
