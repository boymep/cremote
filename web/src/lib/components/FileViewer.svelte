<script lang="ts">
  import { viewer, closeFile, sessionOf } from '../fileviewer.svelte';
  import Markdown from './Markdown.svelte';

  const MAX_TEXT = 1024 * 1024;
  type Mode = 'preview' | 'render' | 'image' | 'code';
  interface Meta {
    name: string;
    size: number;
    kind: 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'binary';
    mime: string;
    path?: string;
  }
  /** Вид файла для выбора режимов. */
  type Type = 'html' | 'md' | 'svg' | 'code' | 'image' | 'pdf' | 'video' | 'audio' | 'other';

  let meta = $state<Meta | null>(null);
  let error = $state('');
  let loading = $state(false);
  let body = $state('');
  let truncated = $state(false);
  let picked = $state<Mode | null>(null);
  let rawSrc = $state('');
  let rawError = $state('');
  let zoomed = $state(false);

  function errorText(status: number): string {
    if (status === 403) return 'Доступ к файлу закрыт.';
    if (status === 404) return 'Файл не найден.';
    if (status === 400) return 'Некорректный путь к файлу.';
    if (status === 401) return 'Нужно войти заново.';
    return `Не удалось открыть файл (${status}).`;
  }

  const type = $derived.by<Type>(() => {
    if (!meta) return 'other';
    const ext = meta.name.toLowerCase().split('.').pop() ?? '';
    if (meta.kind === 'text') {
      if (ext === 'html' || ext === 'htm') return 'html';
      if (ext === 'md' || ext === 'markdown') return 'md';
      if (ext === 'svg') return 'svg';
      return 'code';
    }
    return meta.kind === 'binary' ? 'other' : meta.kind;
  });

  const MODES: Partial<Record<Type, { id: Mode; label: string }[]>> = {
    html: [
      { id: 'preview', label: 'Предпросмотр' },
      { id: 'code', label: 'Код' },
    ],
    md: [
      { id: 'render', label: 'Отрисовка' },
      { id: 'code', label: 'Код' },
    ],
    svg: [
      { id: 'image', label: 'Картинка' },
      { id: 'code', label: 'Код' },
    ],
  };
  const modes = $derived(MODES[type] ?? []);

  function stored(t: Type): Mode | null {
    try {
      return localStorage.getItem(`cremote.viewer.mode.${t}`) as Mode | null;
    } catch {
      return null;
    }
  }

  const mode = $derived.by<Mode | null>(() => {
    if (!modes.length) return null;
    const ok = (m: Mode | null) => (m && modes.some((x) => x.id === m) ? m : null);
    return ok(picked) ?? ok(stored(type)) ?? modes[0].id;
  });

  function pick(m: Mode) {
    picked = m;
    try {
      localStorage.setItem(`cremote.viewer.mode.${type}`, m);
    } catch {
      /* режим просто не запомнится */
    }
  }

  $effect(() => {
    const url = viewer.url;
    meta = null;
    error = '';
    body = '';
    truncated = false;
    picked = null;
    rawSrc = '';
    rawError = '';
    zoomed = false;
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
      } catch {
        if (!ac.signal.aborted) error = 'Нет связи с сервером.';
      } finally {
        if (!ac.signal.aborted) loading = false;
      }
    })();
    return () => ac.abort();
  });

  // Предпросмотр HTML: сервер выдаёт токен на папку файла, iframe грузит страницу и её ресурсы по нему.
  $effect(() => {
    if (type !== 'html' || mode !== 'preview' || !meta?.path || rawSrc) return;
    const ac = new AbortController();
    const session = sessionOf(viewer.url ?? '');
    (async () => {
      try {
        const r = await fetch('/api/file/grant', {
          method: 'POST',
          signal: ac.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: meta!.path, session }),
        });
        if (!r.ok) return void (rawError = errorText(r.status));
        rawSrc = ((await r.json()) as { url: string }).url;
      } catch {
        if (!ac.signal.aborted) rawError = 'Не удалось подготовить предпросмотр.';
      }
    })();
    return () => ac.abort();
  });

  // SVG показываем через <img> из blob: так скрипты внутри картинки не выполняются.
  let svgUrl = $state('');
  $effect(() => {
    if (type !== 'svg' || !body) {
      svgUrl = '';
      return;
    }
    const u = URL.createObjectURL(new Blob([body], { type: 'image/svg+xml' }));
    svgUrl = u;
    return () => URL.revokeObjectURL(u);
  });

  const baseDir = $derived(meta?.path ? meta.path.slice(0, meta.path.lastIndexOf('/')) || '/' : undefined);

  function size(n: number): string {
    return n < 1024 ? `${n} Б` : n < 1048576 ? `${Math.round(n / 1024)} КБ` : `${(n / 1048576).toFixed(1)} МБ`;
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && viewer.url && closeFile()} />

{#if viewer.url}
  <div class="screen" role="dialog" aria-modal="true" aria-label="Просмотр файла">
    <header>
      <div class="row">
        <button type="button" class="back" onclick={closeFile}>← Назад</button>
        <span class="name">{meta?.name ?? 'Файл'}</span>
        {#if meta}
          <a class="dl" href={viewer.url} download={meta.name}>Скачать</a>
        {/if}
      </div>
      {#if modes.length}
        <div class="seg" role="tablist">
          {#each modes as m (m.id)}
            <button type="button" role="tab" aria-selected={mode === m.id} class:on={mode === m.id} onclick={() => pick(m.id)}>{m.label}</button>
          {/each}
        </div>
      {/if}
    </header>
    <div class="content" class:flush={mode === 'preview' || type === 'pdf'}>
      {#if loading}
        <p class="state">Загружаем…</p>
      {:else if error}
        <p class="state err">{error}</p>
      {:else if meta}
        {#if type === 'html' && mode === 'preview'}
          {#if rawError}
            <p class="state err">{rawError}</p>
          {:else if rawSrc}
            <iframe title={meta.name} src={rawSrc} sandbox="allow-scripts allow-popups allow-forms"></iframe>
          {:else}
            <p class="state">Готовим предпросмотр…</p>
          {/if}
        {:else if type === 'md' && mode === 'render'}
          <Markdown text={body} sessionId={sessionOf(viewer.url)} {baseDir} />
          {#if truncated}<p class="state">Показан только первый мегабайт из {size(meta.size)}.</p>{/if}
        {:else if type === 'svg' && mode === 'image'}
          {#if svgUrl}<img src={svgUrl} alt={meta.name} />{/if}
        {:else if meta.kind === 'text'}
          <pre>{body}</pre>
          {#if truncated}<p class="state">Показан только первый мегабайт из {size(meta.size)}.</p>{/if}
        {:else if type === 'image'}
          <!-- Тап — реальный размер и прокрутка, щипок — масштаб браузера. -->
          <div class="pan" class:zoomed>
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
            <img src={viewer.url} alt={meta.name} onclick={() => (zoomed = !zoomed)} />
          </div>
        {:else if type === 'pdf'}
          <iframe title={meta.name} src={viewer.url}></iframe>
          <a class="act float" href={viewer.url} target="_blank" rel="noopener noreferrer">Открыть отдельно</a>
        {:else if type === 'video'}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video src={viewer.url} controls playsinline></video>
          <a class="act" href={viewer.url} target="_blank" rel="noopener noreferrer">Открыть отдельно</a>
        {:else if type === 'audio'}
          <audio src={viewer.url} controls></audio>
          <a class="act" href={viewer.url} target="_blank" rel="noopener noreferrer">Открыть отдельно</a>
        {:else}
          <p class="state">{meta.name} · {size(meta.size)}</p>
          <a class="act" href={viewer.url} download={meta.name}>Скачать</a>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .screen {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--fg);
    padding-bottom: var(--safe-bottom);
    overscroll-behavior: contain;
  }
  header {
    flex: none;
    position: sticky;
    top: 0;
    padding-top: var(--safe-top);
    padding-left: var(--safe-left);
    padding-right: var(--safe-right);
    border-bottom: 0.5px solid var(--border);
    background: var(--bg);
  }
  .row {
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
    text-align: center;
  }
  .back,
  .dl {
    min-height: var(--tap);
    display: inline-flex;
    align-items: center;
    padding: 0;
    background: none;
    border: 0;
    color: var(--accent);
    font: inherit;
    text-decoration: none;
    cursor: pointer;
    white-space: nowrap;
  }
  .seg {
    display: flex;
    gap: 2px;
    margin: 0 var(--s-4) var(--s-2);
    padding: 2px;
    border-radius: var(--radius-nested);
    background: var(--bg-sunken);
  }
  .seg button {
    flex: 1;
    min-height: 32px;
    border: 0;
    border-radius: var(--radius-segment);
    background: none;
    color: var(--fg);
    font: inherit;
    font-size: 0.9em;
    cursor: pointer;
  }
  .seg button.on {
    background: var(--bg-elev);
    font-weight: var(--w-semibold);
  }
  .content {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    padding: var(--s-3) var(--s-4);
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  .content.flush {
    padding: 0;
    gap: 0;
    overflow: hidden;
  }
  iframe {
    flex: 1;
    width: 100%;
    border: 0;
    background: #fff;
  }
  .float {
    position: absolute;
    right: var(--s-4);
    bottom: var(--s-4);
  }
  video {
    width: 100%;
    max-height: 70vh;
  }
  audio {
    width: 100%;
  }
  .pan {
    flex: 1;
    min-height: 0;
    overflow: auto;
    touch-action: pan-x pan-y pinch-zoom;
    display: flex;
  }
  .pan img {
    max-width: 100%;
    max-height: 100%;
    margin: auto;
    object-fit: contain;
  }
  .pan.zoomed img {
    max-width: none;
    max-height: none;
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
