<script lang="ts">
  import { tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { app, routeHref } from '../state.svelte';
  import { modeHint, modeLabel, PERMISSION_MODES, type PermissionMode } from '../protocol';
  import { OPEN_GUESS_HINT, openLabel, SOURCE_LABEL, STATUS_LABEL, shortPath } from '../format';
  import ConnDot from './ConnDot.svelte';
  import Feed from './Feed.svelte';
  import PermissionCard from './PermissionCard.svelte';
  import BlockedCard from './BlockedCard.svelte';
  import QuestionCard from './QuestionCard.svelte';
  import Composer from './Composer.svelte';
  import NetBanner from './NetBanner.svelte';
  import StatusLine from './StatusLine.svelte';

  let { sessionId }: { sessionId: string } = $props();

  const session = $derived(app.sessionById(sessionId));
  const feed = $derived(app.feeds[sessionId]);
  const pending = $derived(app.pendingFor(sessionId));
  const otherPending = $derived(app.pending.length - pending.length);

  let scroller: HTMLDivElement | undefined = $state();
  /** Высота шапки: лента начинается под ней, но прокручивается под полупрозрачный фон. */
  let navH = $state(0);
  let content: HTMLDivElement | undefined = $state();
  let atBottom = true;
  let firstPaint = true;
  let snap = { h: 0, top: 0 };

  function nearBottom(el: HTMLElement) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }
  function toBottom() {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }
  function onScroll() {
    if (!scroller) return;
    atBottom = nearBottom(scroller);
    if (scroller.scrollTop < 200 && feed?.hasMore && !feed.loadingMore && !firstPaint) {
      // Подгружаем заранее, когда пользователь почти наверху.
      app.loadMore(sessionId);
    }
  }

  $effect.pre(() => {
    void feed?.version;
    if (scroller) snap = { h: scroller.scrollHeight, top: scroller.scrollTop };
  });

  $effect(() => {
    const v = feed?.version;
    const mode = feed?.lastMode;
    if (!scroller || v == null) return;
    if (mode === 'prepend') {
      scroller.scrollTop = snap.top + (scroller.scrollHeight - snap.h);
    } else if (firstPaint || mode === 'replace' || atBottom) {
      toBottom();
      void tick().then(() => {
        toBottom();
        firstPaint = false;
      });
    }
  });

  // Размер ленты меняется от карточек pending, картинок и раскрытия блоков.
  $effect(() => {
    if (!scroller || !content) return;
    const ro = new ResizeObserver(() => {
      if (atBottom) toBottom();
    });
    ro.observe(scroller);
    ro.observe(content);
    return () => ro.disconnect();
  });

  // Клавиатура меняет --vvh: лента сжимается, и если пользователь был внизу, остаёмся внизу.
  $effect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const keep = () => {
      if (atBottom) requestAnimationFrame(toBottom);
    };
    vv.addEventListener('resize', keep);
    return () => vv.removeEventListener('resize', keep);
  });

  const waiting = $derived(
    pending.some((p) => p.kind === 'permission')
      ? ('permission' as const)
      : pending.length
        ? ('question' as const)
        : undefined,
  );
  const showStatus = $derived(session?.status === 'working' || !!waiting);
  const queued = $derived(session?.queued ?? []);
  const cancelling = new SvelteSet<string>();

  async function cancelQueued(id: string) {
    cancelling.add(id);
    try {
      await app.request({ type: 'cancel_queued', sessionId, id });
    } catch (e) {
      app.toast((e as Error).message, 'error');
    } finally {
      cancelling.delete(id);
    }
  }

  async function setMode(mode: PermissionMode) {
    try {
      await app.request({ type: 'set_mode', sessionId, mode });
    } catch (e) {
      app.toast((e as Error).message, 'error');
    }
  }
</script>

<div class="view">
  <!-- Шапка как навбар iOS: полупрозрачная, лента прокручивается под ней. -->
  <div class="ios-nav solid nav" bind:clientHeight={navH}>
    <header class="ios-nav-row top">
      <a
        class="ios-nav-btn back"
        href={routeHref({ name: 'list' })}
        aria-label="К списку сессий"
        onclick={(e) => {
          e.preventDefault();
          app.back();
        }}>
        <svg class="ios-icon heavy" width="12" height="24" viewBox="0 0 12 24" aria-hidden="true"><path d="M10 4l-8 8 8 8" /></svg>
        {#if otherPending > 0}<span class="ios-badge danger other" aria-label="Ждут ответа в других сессиях: {otherPending}"
            >{otherPending}</span
          >{/if}
      </a>
      <div class="info">
        <div class="title">{session?.title || 'Сессия'}</div>
        <div class="sub">
          {#if session}
            <span
              class="ios-status {session.status}"
              class:guess={session.open && session.openGuess}
              title={session.open && session.openGuess ? OPEN_GUESS_HINT : undefined}
              >{STATUS_LABEL[session.status] ?? session.status}</span
            >
            <span class="ios-sep" aria-hidden="true">·</span>
            {#if session.open}
              <span
                class="open-mark"
                aria-label={session.openGuess
                  ? `${openLabel(session.source)}, ${OPEN_GUESS_HINT.toLowerCase()}`
                  : undefined}>{openLabel(session.source)}</span
              >
            {:else}
              <span>{SOURCE_LABEL[session.source] ?? session.source}</span>
            {/if}
            <span class="ios-sep" aria-hidden="true">·</span>
            <span class="proj" title={session.cwd}>{shortPath(session.cwd)}</span>
          {:else if app.synced}
            <span>сессия не найдена в списке</span>
          {/if}
        </div>
      </div>
      <div class="right"><ConnDot /></div>
    </header>
    <NetBanner />

    {#if session?.source === 'sdk'}
      <div class="modebar">
        <label for="mode-{sessionId}">Режим</label>
        <select
          id="mode-{sessionId}"
          class="field"
          title={modeHint(session.permissionMode ?? 'default')}
          value={session.permissionMode ?? 'default'}
          onchange={(e) => setMode(e.currentTarget.value as PermissionMode)}
        >
          {#each PERMISSION_MODES as m (m.value)}
            {#if m.muted}<option disabled>──────────</option>{/if}
            <option value={m.value}>{m.label}</option>
          {/each}
          {#if session.permissionMode && !PERMISSION_MODES.some((m) => m.value === session.permissionMode)}
            <option value={session.permissionMode} disabled>{modeLabel(session.permissionMode)}</option>
          {/if}
        </select>
      </div>
    {/if}
  </div>

  <div class="feed" bind:this={scroller} onscroll={onScroll}>
    <div class="content" bind:this={content} style:padding-top="{navH + 16}px">
      {#if feed?.hasMore}
        <button class="btn btn-ghost btn-block" disabled={feed.loadingMore} onclick={() => app.loadMore(sessionId)}>
          {feed.loadingMore ? 'Загружаем…' : 'Загрузить ещё'}
        </button>
      {/if}
      {#if !feed?.loaded}
        <p class="state muted">
          {app.synced
            ? 'Загружаем сообщения…'
            : app.net === 'down' || app.net === 'offline'
              ? 'Сообщения появятся, когда связь восстановится.'
              : 'Подключаемся…'}
        </p>
      {:else if feed.messages.length === 0}
        <p class="state muted">Сообщений пока нет.</p>
      {:else}
        <Feed messages={feed.messages} cwd={session?.cwd} sessionId={session?.id} />
      {/if}
      {#if showStatus}<StatusLine activity={session?.activity} {waiting} />{/if}
      {#each queued as q (q.id)}
        <div class="queued">
          <div class="qhead">
            <span class="qlabel">
              <svg class="ios-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"
                ><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg
              >В очереди</span
            >
            <button
              class="qcancel"
              type="button"
              aria-label="Отменить сообщение в очереди"
              title="Отменить"
              disabled={cancelling.has(q.id) || app.net !== 'ok'}
              onclick={() => cancelQueued(q.id)}
              ><svg class="ios-icon heavy" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg></button
            >
          </div>
          {#if q.text}<p class="qtext">{q.text}</p>{/if}
          {#if q.attachments.length}<p class="qatt">Картинок: {q.attachments.length}</p>{/if}
        </div>
      {/each}
    </div>
  </div>

  {#if pending.length > 0}
    <div class="pinned">
      {#each pending as p (p.id)}
        {#if p.kind === 'permission' && p.blocked}
          <BlockedCard {p} cwd={session?.cwd} />
        {:else if p.kind === 'permission'}
          <PermissionCard {p} cwd={session?.cwd} />
        {:else}
          <QuestionCard {p} />
        {/if}
      {/each}
    </div>
  {/if}

  <Composer {sessionId} {session} />
</div>

<style>
  .view {
    /* Высота и сдвиг — от visualViewport (lib/viewport.ts): поле ввода всегда над клавиатурой. */
    position: fixed;
    left: 0;
    right: 0;
    top: var(--vvt, 0px);
    height: var(--vvh, 100dvh);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg);
  }
  /* Панель та же, что на других экранах (.ios-nav), но лента прокручивается под ней. */
  .nav {
    position: absolute;
    left: 0;
    right: 0;
    z-index: 3;
  }
  .top {
    grid-template-columns: var(--tap) minmax(0, 1fr) var(--tap);
    /* Воздух над и под блоком заголовка: по --s-2 сверху и снизу к обычной высоте строки. */
    height: calc(var(--nav-h) + var(--s-2) * 2);
  }
  .other {
    position: absolute;
    top: 0;
    left: var(--s-6);
  }
  .right {
    display: flex;
    justify-content: flex-end;
  }
  .info {
    min-width: 0;
    text-align: center;
  }
  /* Шапка без анимаций и трансформаций: заголовок рисуется чётко. */
  .title {
    font: var(--t-nav);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    -webkit-font-smoothing: antialiased;
  }
  /* Статус, источник и путь — одна строка с общей базовой линией; сжимается только путь. */
  .sub {
    display: flex;
    justify-content: center;
    align-items: baseline;
    gap: var(--s-1);
    min-width: 0;
    height: 16px;
    font: var(--t-caption);
    color: var(--fg-muted);
    white-space: nowrap;
  }
  .sub > * {
    flex: none;
  }
  .open-mark {
    color: var(--ok);
  }
  .sub .proj {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font: var(--t-mono-caption);
  }
  .modebar {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    padding: 0 calc(var(--gutter) + var(--safe-right)) var(--s-2) calc(var(--gutter) + var(--safe-left));
    font: var(--t-subhead);
    color: var(--fg-muted);
  }
  /* Без системного оформления iOS не даёт задать высоту: значок ▾ рисуем сами. */
  .modebar select {
    flex: 1;
    min-width: 0;
    height: var(--tap);
    padding: 0 var(--s-8) 0 var(--s-3);
    -webkit-appearance: none;
    appearance: none;
    background: var(--bg-elev)
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4' fill='none' stroke='%238e8e93' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")
      right var(--s-3) center / var(--icon-sm) no-repeat;
    color: var(--fg);
  }
  .feed {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }
  .content {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    padding: var(--s-4) calc(var(--gutter) + var(--safe-right)) var(--s-4) calc(var(--gutter) + var(--safe-left));
    max-width: 860px;
    margin: 0 auto;
    min-width: 0;
  }
  .state {
    text-align: center;
    margin: var(--s-8) 0;
  }
  /* Пузырь в очереди: рамка — контуром, чтобы не сдвигать содержимое с сетки. */
  .queued {
    align-self: flex-end;
    max-width: min(82%, 560px);
    min-width: 0;
    padding: var(--s-2) var(--s-4);
    border-radius: var(--radius-bubble) var(--radius-bubble) var(--radius-tail) var(--radius-bubble);
    outline: 1px dashed color-mix(in srgb, var(--accent) 60%, transparent);
    outline-offset: -1px;
    background: color-mix(in srgb, var(--accent) 12%, var(--bg));
  }
  .qhead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
  }
  .qlabel {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    font: var(--t-footnote);
    font-weight: var(--w-semibold);
    color: var(--fg-muted);
  }
  /* Значок 16 на правом поле пузыря, зона нажатия 44 за счёт псевдоэлемента. */
  .qcancel {
    position: relative;
    flex: none;
    width: var(--icon-sm);
    height: var(--icon-sm);
    padding: 0;
    border: 0;
    background: none;
    color: var(--fg-muted);
    cursor: pointer;
  }
  .qcancel::after {
    content: '';
    position: absolute;
    inset: -14px;
  }
  .qtext {
    margin: var(--s-1) 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .qatt {
    margin: var(--s-1) 0 0;
    font: var(--t-footnote);
    color: var(--fg-muted);
  }
  .pinned {
    flex: none;
    max-height: 55%;
    max-height: round(down, 55%, 4px);
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    padding: var(--s-2) calc(var(--gutter) + var(--safe-right)) var(--s-2) calc(var(--gutter) + var(--safe-left));
    background: var(--bg);
    box-shadow: 0 -0.5px 0 var(--border-strong);
  }
</style>
