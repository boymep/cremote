<script lang="ts">
  import type { ToolResultBlock, ToolUseBlock } from '../protocol';
  import { toolSummary } from '../tools';
  import ToolInput from './ToolInput.svelte';
  import { fileUrl } from '../markdown';
  import { openFile } from '../fileviewer.svelte';

  interface Props {
    block: ToolUseBlock;
    result?: ToolResultBlock;
    cwd?: string;
    sessionId?: string;
  }
  let { block, result, cwd, sessionId }: Props = $props();

  let open = $state(false);
  const summary = $derived(toolSummary(block.name, block.input, cwd));
  const isFileEdit = $derived(['Edit', 'MultiEdit', 'Write'].includes(block.name));
  const phase = $derived(!result ? 'running' : result.isError ? 'error' : 'done');
  /** Иконка в духе SF Symbols по группе инструмента. */
  const icon = $derived.by(() => {
    const n = block.name;
    if (n === 'Bash' || n === 'BashOutput' || n === 'KillShell' || n === 'KillBash') return 'terminal';
    if (n === 'Read' || n === 'NotebookRead') return 'doc';
    if (n === 'Edit' || n === 'MultiEdit' || n === 'Write' || n === 'NotebookEdit') return 'pencil';
    if (n === 'Grep' || n === 'Glob' || n === 'ToolSearch') return 'search';
    if (n === 'WebFetch' || n === 'WebSearch') return 'globe';
    if (n === 'Task' || n === 'Agent') return 'agent';
    if (n === 'TodoWrite') return 'list';
    return 'gear';
  });
  /** Путь файла у Read/Write/Edit: по нему можно открыть файл во встроенном просмотрщике. */
  const filePath = $derived.by(() => {
    if (!['Read', 'Write', 'Edit', 'MultiEdit'].includes(block.name)) return '';
    const p = (block.input as { file_path?: unknown } | null)?.file_path;
    return typeof p === 'string' ? p : '';
  });
  const showResult = $derived(!!result && (result.isError || !isFileEdit) && result.text.trim() !== '');
</script>

<div class="tool {phase}">
  <button class="sum" type="button" aria-expanded={open} onclick={() => (open = !open)}>
    <svg class="ios-icon icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      {#if icon === 'terminal'}
        <rect x="3" y="4.5" width="18" height="15" rx="3" /><path d="M7 10l3 2.5L7 15M12.5 15H17" />
      {:else if icon === 'doc'}
        <path d="M6 3.5h8l4 4v13H6z" /><path d="M14 3.5v4h4M9 12.5h6M9 16h6" />
      {:else if icon === 'pencil'}
        <path d="M4 20l1-4.5L15.5 5a2.1 2.1 0 0 1 3 3L8 18.5z" /><path d="M13.5 7l3 3" />
      {:else if icon === 'search'}
        <circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l5 5" />
      {:else if icon === 'globe'}
        <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z" />
      {:else if icon === 'agent'}
        <circle cx="12" cy="8" r="4" /><path d="M4.5 20c1.4-3.6 4.2-5.4 7.5-5.4s6.1 1.8 7.5 5.4" />
      {:else if icon === 'list'}
        <path d="M9 6.5h11M9 12h11M9 17.5h11" /><path d="M4 6.5l1 1 2-2M4 12l1 1 2-2M4 17.5l1 1 2-2" />
      {:else}
        <circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
      {/if}
    </svg>
    <span class="line">
      <span class="verb">{summary.verb}</span>
      <span class="detail" class:mono={summary.mono}>{summary.detail}</span>
    </span>
    {#if phase === 'error'}<span class="ios-tag danger">ошибка</span>{/if}
    <svg class="ios-icon heavy chev" width="8" height="16" viewBox="0 0 8 16" aria-hidden="true"><path d="M1 2l6 6-6 6" /></svg>
  </button>
  {#if open}
    <div class="body">
      {#if filePath}
        <button type="button" class="open-file" onclick={() => openFile(fileUrl(filePath, { cwd, sessionId }))}>Открыть файл</button>
      {/if}
      <ToolInput name={block.name} input={block.input} {cwd} />
      {#if showResult && result}
        <div class="result-label">{result.isError ? 'Ошибка' : 'Результат'}</div>
        <pre class="result" class:err={result.isError}>{result.text}</pre>
      {:else if !result}
        <div class="result-label">Выполняется…</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tool {
    min-width: 0;
    max-width: 100%;
  }
  /* Компактная серая строка, как ячейка iOS: иконка, название, детали, шеврон. */
  .sum {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    width: 100%;
    min-height: var(--tap);
    padding: var(--s-2) var(--s-3);
    background: var(--bg-elev);
    border: 0;
    border-radius: var(--radius-nested);
    text-align: left;
    cursor: pointer;
    font: var(--t-subhead);
    color: var(--fg);
    -webkit-tap-highlight-color: transparent;
  }
  .sum:active {
    opacity: 0.6;
  }
  .icon {
    color: var(--fg-muted);
  }
  .running .icon {
    color: var(--accent);
    animation: blink 1.2s ease-in-out infinite;
  }
  .error .icon {
    color: var(--danger);
  }
  /* Название и детали разного размера — на одной базовой линии. */
  .line {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: var(--s-2);
    height: 20px;
  }
  .verb {
    flex: none;
    font-weight: var(--w-semibold);
  }
  .detail {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-muted);
  }
  .detail.mono {
    font: var(--t-mono);
  }
  .chev {
    color: var(--fg-faint);
    transition: transform 0.15s;
  }
  [aria-expanded='true'] .chev {
    transform: rotate(90deg);
  }
  .body {
    padding: var(--s-2) 0 var(--s-1);
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    min-width: 0;
  }
  .open-file {
    align-self: flex-start;
    min-height: var(--tap);
    padding: 0 var(--s-2);
    background: none;
    border: 0;
    color: var(--accent);
    font: var(--t-subhead);
    cursor: pointer;
  }
  .result-label {
    font: var(--t-footnote);
    color: var(--fg-muted);
  }
  .result {
    margin: 0;
    padding: var(--s-2) var(--s-3);
    border-radius: var(--radius-nested);
    background: var(--bg-elev);
    font: var(--t-mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: round(down, 40vh, 4px);
    overflow: auto;
    overscroll-behavior: contain;
  }
  .result.err {
    background: var(--danger-soft);
    color: var(--fg);
  }
  @keyframes blink {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .running .icon {
      animation: none;
    }
    .chev {
      transition: none;
    }
  }
</style>
