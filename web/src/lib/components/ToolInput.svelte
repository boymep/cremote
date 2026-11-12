<script lang="ts">
  import { prettyJson, toolDiff } from '../tools';
  import { shortPath } from '../format';
  import DiffView from './DiffView.svelte';

  let { name, input, cwd }: { name: string; input: unknown; cwd?: string } = $props();

  const i = $derived(input && typeof input === 'object' ? (input as Record<string, unknown>) : {});
  const diff = $derived(toolDiff(name, input, cwd));
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
</script>

{#if diff}
  <DiffView {diff} />
{:else if name === 'Bash'}
  {#if str(i.description)}<p class="desc">{str(i.description)}</p>{/if}
  <pre class="box cmd"><span class="prompt">$ </span>{str(i.command)}</pre>
{:else if name === 'Read' && str(i.file_path)}
  <p class="kv mono">{shortPath(str(i.file_path), cwd)}{#if i.offset || i.limit}<span class="muted">
        · строки {i.offset ?? 1}…{i.limit ? Number(i.offset ?? 1) + Number(i.limit) : ''}</span
      >{/if}</p>
{:else}
  <pre class="box">{prettyJson(input)}</pre>
{/if}

<style>
  .box {
    margin: 0;
    padding: var(--s-2) var(--s-3);
    background: var(--bg-sunken);
    border-radius: var(--radius-nested);
    font: var(--t-mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: round(down, 50vh, 4px);
    overflow: auto;
  }
  .cmd .prompt {
    color: var(--fg-faint);
    user-select: none;
  }
  .desc {
    margin: 0 0 var(--s-1);
    font: var(--t-subhead);
    color: var(--fg-muted);
  }
  .kv {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
