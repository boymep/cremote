<script lang="ts">
  import { formatSize, type Attachments } from '../attachments.svelte';

  let { att }: { att: Attachments } = $props();
</script>

{#if att.items.length > 0}
  <ul class="strip">
    {#each att.items as a (a.key)}
      <li class="{a.status} {a.isImage ? 'img' : 'doc'}" title={a.error ?? a.name}>
        {#if a.isImage}
          <img src={a.preview} alt={a.name} />
        {:else}
          <svg class="ios-icon file" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"
            ><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg
          >
          <span class="meta"
            ><span class="name">{a.name}</span><span class="size">{a.error ?? formatSize(a.size)}</span></span
          >
        {/if}
        {#if a.status === 'uploading'}<span class="ov">…</span>{/if}
        {#if a.status === 'error'}<span class="ov err">!</span>{/if}
        <button type="button" class="rm" aria-label="Убрать {a.name}" onclick={() => att.remove(a.key)}
          ><svg class="ios-icon heavy" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg></button
        >
      </li>
    {/each}
  </ul>
{/if}

<style>
  .strip {
    list-style: none;
    margin: 0;
    padding: var(--s-2) 0 0;
    display: flex;
    gap: var(--s-2);
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }
  li {
    position: relative;
    flex: none;
    width: 64px;
    height: 64px;
    border-radius: var(--radius-nested);
    box-shadow: 0 0 0 0.5px var(--border-strong);
  }
  li.doc {
    width: auto;
    max-width: 200px;
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: 0 var(--s-8) 0 var(--s-2);
    background: var(--bg-elev);
  }
  .file {
    flex: none;
    color: var(--fg-muted);
  }
  .meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
    font: var(--t-subhead);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .size {
    color: var(--fg-muted);
    font-size: 12px;
  }
  li.error {
    box-shadow: 0 0 0 1px var(--danger);
  }
  img {
    width: 100%;
    height: 100%;
    border-radius: inherit;
    object-fit: cover;
    display: block;
  }
  .ov {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    border-radius: inherit;
    background: rgb(0 0 0 / 0.4);
    color: #fff;
    font-weight: var(--w-semibold);
  }
  .ov.err {
    background: rgb(192 57 43 / 0.55);
  }
  /* Круг 24 внутри картинки; зона нажатия 44 за счёт псевдоэлемента. */
  .rm {
    position: absolute;
    top: var(--s-1);
    right: var(--s-1);
    display: grid;
    place-items: center;
    width: var(--s-6);
    height: var(--s-6);
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: rgb(0 0 0 / 0.55);
    color: #fff;
    cursor: pointer;
  }
  .rm::after {
    content: '';
    position: absolute;
    inset: -10px;
  }
</style>
