<script lang="ts">
  import { viewer, closeFile } from '../fileviewer.svelte';

  const MAX_TEXT = 1024 * 1024;
  interface Meta {
    name: string;
    size: number;
    kind: 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'binary';
    mime: string;
  }

  let meta = $state<Meta | null>(null);
  let error = $state('');
  let loading = $state(false);
  let body = $state('');
  let truncated = $state(false);

  function errorText(status: number): string {
    if (status === 403) return 'Доступ к файлу закрыт.';
    if (status === 404) return 'Файл не найден.';
    if (status === 400) return 'Некорректный путь к файлу.';
    if (status === 401) return 'Нужно войти заново.';
    return `Не удалось открыть файл (${status}).`;
  }

  $effect(() => {
    const url = viewer.url;
    meta = null;
    error = '';
    body = '';
    truncated = false;
    if (!url) return;
    const ac = new AbortController();
    loading = true;
    (async () => {
      try {
        const mr = await fetch(`${url}&meta=1`, { signal: ac.signal });
        if (!mr.ok) return void (error = errorText(mr.status));
        const m = (await mr.json()) as Meta;
        meta = m;
        if (m.kind === 'text') {
          const r = await fetch(url, { signal: ac.signal, headers: { Range: `bytes=0-${MAX_TEXT - 1}` } });
          if (!r.ok) return void (error = errorText(r.status));
          body = await r.text();
          truncated = m.size > MAX_TEXT;
        }
      } catch (e) {
        if (!ac.signal.aborted) error = 'Нет связи с сервером.';
      } finally {
        if (!ac.signal.aborted) loading = false;
      }
    })();
    return () => ac.abort();
  });

  function size(n: number): string {
    return n < 1024 ? `${n} Б` : n < 1048576 ? `${Math.round(n / 1024)} КБ` : `${(n / 1048576).toFixed(1)} МБ`;
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && viewer.url && closeFile()} />

{#if viewer.url}
  <div class="overlay" role="dialog" aria-modal="true" aria-label="Просмотр файла">
    <header>
      <span class="name">{meta?.name ?? 'Файл'}</span>
      <button type="button" class="close" onclick={closeFile}>Закрыть</button>
    </header>
    <div class="content">
      {#if loading}
        <p class="state">Загружаем…</p>
      {:else if error}
        <p class="state err">{error}</p>
      {:else if meta}
        {#if meta.kind === 'image'}
          <img src={viewer.url} alt={meta.name} />
        {:else if meta.kind === 'text'}
          <pre>{body}</pre>
          {#if truncated}<p class="state">Показан только первый мегабайт из {size(meta.size)}.</p>{/if}
        {:else if meta.kind === 'binary'}
          <p class="state">{meta.name} · {size(meta.size)}</p>
          <a class="act" href={viewer.url} download={meta.name}>Скачать</a>
        {:else}
          <p class="state">{meta.name} · {size(meta.size)}</p>
          <a class="act" href={viewer.url} target="_blank" rel="noopener noreferrer">Открыть</a>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--fg);
    padding-top: var(--safe-top);
    padding-bottom: var(--safe-bottom);
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    padding: 0 var(--s-4);
    min-height: var(--tap);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: var(--w-semibold);
  }
  .close {
    min-height: var(--tap);
    padding: 0 var(--s-2);
    background: none;
    border: 0;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
  }
  .content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: var(--s-3) var(--s-4);
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  img {
    max-width: 100%;
    margin: auto;
    object-fit: contain;
  }
  pre {
    margin: 0;
    font: var(--t-mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .state {
    margin: 0;
    color: var(--fg-muted);
  }
  .state.err {
    color: var(--danger);
  }
  .act {
    align-self: flex-start;
    padding: var(--s-2) var(--s-4);
    border-radius: var(--radius-nested);
    background: var(--accent);
    color: var(--accent-fg);
    text-decoration: none;
  }
</style>
