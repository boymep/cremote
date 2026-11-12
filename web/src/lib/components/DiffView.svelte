<script lang="ts">
  import type { FileDiff } from '../tools';

  let { diff, maxLines = 400 }: { diff: FileDiff; maxLines?: number } = $props();
  let showAll = $state(false);
  const lines = $derived(showAll ? diff.lines : diff.lines.slice(0, maxLines));
</script>

<div class="diff">
  <div class="head">
    <span class="path mono">{diff.path}</span>
    <span class="stat"
      >{#if diff.added}<span class="a">+{diff.added}</span>{/if}
      {#if diff.removed}<span class="r">−{diff.removed}</span>{/if}</span
    >
  </div>
  <div class="body mono">
    {#each lines as l, i (i)}
      <div class="ln {l.kind}"><span class="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span><span
          class="code">{l.text || ' '}</span
        ></div>
    {/each}
    {#if lines.length === 0}
      <div class="ln hunk"><span class="sign"></span><span class="code">нет изменений</span></div>
    {/if}
  </div>
  {#if !showAll && diff.lines.length > maxLines}
    <button class="btn btn-ghost btn-block" onclick={() => (showAll = true)}>
      Показать ещё {diff.lines.length - maxLines} строк
    </button>
  {/if}
</div>

<style>
  .diff {
    border-radius: var(--radius-nested);
    overflow: hidden;
    background: var(--bg-elev);
  }
  .head {
    display: flex;
    gap: var(--s-2);
    align-items: baseline;
    justify-content: space-between;
    padding: var(--s-1) var(--s-3);
    background: var(--bg-sunken);
    font: var(--t-mono);
  }
  .path {
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .stat {
    flex: none;
    font-family: var(--mono);
  }
  .a {
    color: var(--ok);
  }
  .r {
    color: var(--danger);
  }
  .body {
    max-height: round(down, 60vh, 4px);
    overflow: auto;
    font: var(--t-mono);
    padding: var(--s-1) 0;
  }
  .ln {
    display: flex;
    min-width: 0;
  }
  .sign {
    flex: none;
    width: var(--icon-sm);
    text-align: center;
    color: var(--fg-faint);
    user-select: none;
  }
  .code {
    flex: 1;
    min-width: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding-right: var(--s-2);
  }
  .add {
    background: var(--diff-add);
    color: var(--diff-add-fg);
  }
  .add .sign {
    color: var(--diff-add-fg);
  }
  .del {
    background: var(--diff-del);
    color: var(--diff-del-fg);
  }
  .del .sign {
    color: var(--diff-del-fg);
  }
  .hunk {
    color: var(--fg-faint);
    font-style: italic;
  }
</style>
