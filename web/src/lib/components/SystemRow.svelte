<script lang="ts">
  import type { MetaBlock, SystemKind } from '../protocol';

  let { block }: { block: MetaBlock } = $props();
  let open = $state(false);

  /** Старый сервер не присылает sys: угадываем тип по началу текста. */
  function guess(text: string): SystemKind {
    const t = text.trimStart();
    if (t.startsWith('Another Claude session') || t.startsWith('<agent-message')) {
      return t.includes('[Subagent hand-back]') ? 'agent_report' : 'agent_message';
    }
    if (t.startsWith('<task-notification')) return 'task';
    if (/^<(command-|local-command-)/.test(t)) return 'command';
    if (t.startsWith('[Request interrupted')) return 'interrupt';
    return 'notice';
  }

  const sys = $derived(block.sys ?? guess(block.text));
  const failed = $derived(sys === 'task' && block.status === 'failed');
  const label = $derived.by(() => {
    switch (sys) {
      case 'agent_report':
        return 'Отчёт агента';
      case 'agent_message':
        return 'Сообщение агента';
      case 'task':
        if (block.status === 'completed') return 'Задача завершена';
        if (block.status === 'failed') return 'Задача не удалась';
        if (block.status === 'stopped' || block.status === 'killed') return 'Задача остановлена';
        return 'Задача';
      case 'command':
        return 'Команда';
      case 'interrupt':
        return 'Прервано пользователем';
      default:
        return 'Системное уведомление';
    }
  });
  const full = $derived((block.body ?? block.text).trim());
  /** Прерывание — одна строка без подробностей. */
  const expandable = $derived(sys !== 'interrupt' && full !== '');
</script>

<div class="sys" class:open>
  <button
    class="chip"
    class:failed
    type="button"
    aria-expanded={expandable ? open : undefined}
    disabled={!expandable}
    onclick={() => (open = !open)}
  >
    <svg class="ios-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      {#if sys === 'agent_report' || sys === 'agent_message'}
        <circle cx="12" cy="8" r="4" /><path d="M4.5 20c1.4-3.6 4.2-5.4 7.5-5.4s6.1 1.8 7.5 5.4" />
      {:else if sys === 'task'}
        {#if failed}
          <circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" />
        {:else}
          <circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.7 2.7L16 9.8" />
        {/if}
      {:else if sys === 'command'}
        <rect x="3" y="4.5" width="18" height="15" rx="3" /><path d="M7 10l3 2.5L7 15M12.5 15H17" />
      {:else if sys === 'interrupt'}
        <circle cx="12" cy="12" r="9" /><rect x="9" y="9" width="6" height="6" rx="1" />
      {:else}
        <circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.6v.1" />
      {/if}
    </svg>
    <span class="lbl">{label}</span>
    {#if block.summary}<span class="ios-sep" aria-hidden="true">·</span><span class="summary">{block.summary}</span>{/if}
    {#if expandable}
      <svg class="ios-icon heavy chev" width="8" height="16" viewBox="0 0 8 16" aria-hidden="true"><path d="M1 2l6 6-6 6" /></svg>
    {/if}
  </button>
  {#if open && expandable}
    <pre class="full">{full}</pre>
  {/if}
</div>

<style>
  .sys {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s-2);
    min-width: 0;
    max-width: 100%;
    align-self: stretch;
  }
  /* Капсула 32, зона нажатия 44 за счёт псевдоэлемента: лента остаётся плотной. */
  .chip {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    max-width: min(100%, 520px);
    min-width: 0;
    min-height: var(--s-8);
    padding: var(--s-1) var(--s-3);
    border: 0;
    border-radius: var(--radius-full);
    background: var(--bg-elev);
    color: var(--fg-muted);
    font: var(--t-footnote);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .chip::after {
    content: '';
    position: absolute;
    inset: -6px 0;
  }
  .chip:disabled {
    cursor: default;
    opacity: 1;
  }
  .chip:active:not(:disabled) {
    opacity: 0.6;
  }
  .chip.failed .ios-icon:first-child {
    color: var(--danger);
  }
  .lbl {
    flex: none;
    font-weight: var(--w-semibold);
    white-space: nowrap;
  }
  .summary {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev {
    color: var(--fg-faint);
    transition: transform 0.15s;
  }
  .open .chev {
    transform: rotate(90deg);
  }
  .full {
    align-self: stretch;
    margin: 0;
    padding: var(--s-2) var(--s-3);
    border-radius: var(--radius-nested);
    background: var(--bg-elev);
    color: var(--fg-muted);
    font: var(--t-mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: round(down, 50vh, 4px);
    overflow: auto;
    overscroll-behavior: contain;
  }
  @media (prefers-reduced-motion: reduce) {
    .chev {
      transition: none;
    }
  }
</style>
