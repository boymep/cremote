<script lang="ts">
  import Markdown from './Markdown.svelte';

  let { text }: { text: string } = $props();
  let open = $state(false);
  const preview = $derived(text.replace(/\s+/g, ' ').trim());
</script>

<div class="thinking">
  <button class="sum" type="button" aria-expanded={open} onclick={() => (open = !open)}>
    <svg class="ios-icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"
      ><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z" /></svg
    >
    <span class="label">Размышления</span>
    {#if !open}<span class="preview">{preview}</span>{/if}
  </button>
  {#if open}
    <div class="body"><Markdown {text} /></div>
  {/if}
</div>

<style>
  /* Те же поля и размер значка, что у строки инструмента: значки стоят в одну колонку. */
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
    color: var(--fg-muted);
    font: var(--t-subhead);
    cursor: pointer;
    border-radius: var(--radius-nested);
  }
  .sum:active {
    background: var(--bg-sunken);
  }
  .label {
    flex: none;
    font-style: italic;
  }
  .preview {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-faint);
  }
  /* Текст начинается под подписью: 12 + 20 + 8; линия слева — внутренней тенью. */
  .body {
    margin: 0 0 var(--s-2) var(--s-6);
    padding-left: var(--s-4);
    box-shadow: inset 2px 0 0 var(--border);
    color: var(--fg-muted);
    font: var(--t-subhead);
  }
  .body :global(.md code) {
    font-size: 13px;
  }
</style>
