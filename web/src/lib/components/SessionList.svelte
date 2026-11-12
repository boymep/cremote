<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { app, routeHref } from '../state.svelte';
  import { OPEN_GUESS_HINT, relativeTime, SOURCE_LABEL, STATUS_LABEL, toMs } from '../format';
  import type { SessionInfo } from '../protocol';
  import NetBanner from './NetBanner.svelte';
  import UpdateBanner from './UpdateBanner.svelte';
  import AccountSummary from './AccountSummary.svelte';
  import { haptic } from '../haptics';

  const COLLAPSED = 5;

  interface Group {
    key: string;
    project: string;
    cwd: string;
    latest: number;
    hasOpen: boolean;
    sessions: SessionInfo[];
  }

  const pendingCount = $derived.by(() => {
    const m = new Map<string, number>();
    for (const p of app.pending) m.set(p.sessionId, (m.get(p.sessionId) ?? 0) + 1);
    return m;
  });

  // Внутри проекта: открытые вкладки первыми (ждут ответа → работают → по свежести), потом остальные по mtime.
  const rank = (s: SessionInfo) =>
    s.open !== true ? 3 : pendingCount.has(s.id) || s.status === 'awaiting_input' ? 0 : s.status === 'working' ? 1 : 2;

  const groups = $derived.by(() => {
    const byCwd = new Map<string, Group>();
    for (const s of app.sessions) {
      const key = s.cwd || s.project || '—';
      let g = byCwd.get(key);
      if (!g) {
        g = { key, project: s.project || key, cwd: s.cwd, latest: 0, hasOpen: false, sessions: [] };
        byCwd.set(key, g);
      }
      g.sessions.push(s);
      g.latest = Math.max(g.latest, toMs(s.mtime));
      if (s.open === true) g.hasOpen = true;
    }
    const list = [...byCwd.values()];
    for (const g of list) g.sessions.sort((a, b) => rank(a) - rank(b) || toMs(b.mtime) - toMs(a.mtime));
    // Проекты с открытыми вкладками — наверху.
    return list.sort((a, b) => Number(b.hasOpen) - Number(a.hasOpen) || b.latest - a.latest);
  });

  const expanded = new SvelteSet<string>();

  function visible(g: Group): SessionInfo[] {
    if (expanded.has(g.key)) return g.sessions;
    // Свёрнутая группа всё равно показывает сессии с pending и активные.
    return g.sessions.filter(
      (s, i) =>
        i < COLLAPSED ||
        s.open === true ||
        pendingCount.has(s.id) ||
        ['working', 'awaiting_input', 'live'].includes(s.status),
    );
  }

  // ---------- Потянуть вниз, чтобы обновить ----------

  const PTR_MAX = 200; // предел «резинки», px
  const PTR_TRIGGER = 70; // столько нужно протянуть для обновления
  const PTR_HOLD = 52; // где держим список, пока идёт обновление

  /** Сдвиг списка вниз, px. */
  let pull = $state(0);
  let pulling = $state(false);
  let refreshing = $state(false);

  // Сопротивление растёт с длиной: палец идёт дальше, чем список.
  const rubber = (d: number) => (PTR_MAX * d) / (d + PTR_MAX);
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  async function refresh() {
    refreshing = true;
    pull = PTR_HOLD;
    const started = Date.now();
    // Сессии сервер присылает сам; без связи — переподключаемся сразу, со связью — обновляем аккаунты.
    // Индикатор не держим дольше пары секунд: у блока аккаунтов свой индикатор.
    const work = app.net === 'ok' ? app.refreshAccounts() : Promise.resolve(app.reconnectNow());
    await Promise.race([work, sleep(2000)]);
    const left = 600 - (Date.now() - started);
    if (left > 0) await sleep(left);
    refreshing = false;
    pull = 0;
  }

  function pullToRefresh(node: HTMLElement) {
    let tracking = false;
    let active = false;
    let armed = false;
    let touchId = -1;
    let startX = 0;
    let startY = 0;

    const onStart = (e: TouchEvent) => {
      tracking = !refreshing && e.touches.length === 1 && node.scrollTop <= 0;
      active = false;
      if (!tracking) return;
      const t = e.touches[0];
      touchId = t.identifier;
      startX = t.clientX;
      startY = t.clientY;
    };
    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const t = Array.from(e.changedTouches).find((c) => c.identifier === touchId);
      if (!t) return;
      const dy = t.clientY - startY;
      const dx = t.clientX - startX;
      if (!active) {
        // Вверх или вбок — обычная прокрутка, не мешаем ей.
        if (dy <= 0 || Math.abs(dx) > dy || node.scrollTop > 0) {
          if (dy < 0 || Math.abs(dx) > 4 || node.scrollTop > 0) tracking = false;
          return;
        }
        active = true;
        armed = false;
        pulling = true;
      }
      // Свой жест вместо системной «резинки» контейнера.
      if (e.cancelable) e.preventDefault();
      pull = rubber(Math.max(0, dy));
      if (!armed && pull >= PTR_TRIGGER) {
        armed = true;
        haptic();
      } else if (armed && pull < PTR_TRIGGER) {
        armed = false;
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (!tracking || !Array.from(e.changedTouches).some((c) => c.identifier === touchId)) return;
      tracking = false;
      if (!active) return;
      active = false;
      pulling = false;
      if (armed && e.type === 'touchend') void refresh();
      else pull = 0;
      armed = false;
    };

    node.addEventListener('touchstart', onStart, { passive: true });
    node.addEventListener('touchmove', onMove, { passive: false });
    node.addEventListener('touchend', onEnd, { passive: true });
    node.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      node.removeEventListener('touchstart', onStart);
      node.removeEventListener('touchmove', onMove);
      node.removeEventListener('touchend', onEnd);
      node.removeEventListener('touchcancel', onEnd);
    };
  }
</script>

<div class="list">
<div class="page" {@attach pullToRefresh}>
  <main
    class:settling={!pulling}
    style:transform={pull > 0 ? `translate3d(0, ${pull}px, 0)` : undefined}
  >
    <div
      class="ptr"
      class:spin={refreshing}
      role="status"
      aria-label={refreshing ? 'Обновляем' : undefined}
      style:opacity={refreshing ? 1 : Math.min(1, pull / PTR_TRIGGER)}
      style:--ptr-turn="{Math.min(1, pull / PTR_TRIGGER) * 270}deg"
    >
      <svg class="ios-icon heavy" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9" /></svg>
    </div>

    <h1 class="ios-large-title">Сессии</h1>

    <NetBanner />
    <UpdateBanner />
    <AccountSummary />

    {#if !app.synced && app.sessions.length === 0}
      <p class="empty">
        {app.net === 'down' || app.net === 'offline' ? 'Список появится, когда связь восстановится.' : 'Загружаем сессии…'}
      </p>
    {:else if groups.length === 0}
      <div class="empty">
        <p>Сессий пока нет.</p>
        <a class="ios-nav-btn" href={routeHref({ name: 'new' })}>Начать новую</a>
      </div>
    {/if}

    {#each groups as g (g.key)}
      {@const shown = visible(g)}
      <section class="ios-section group">
        <h2 class="ios-section-header" title={g.cwd}>{g.project}</h2>
        <ul class="ios-list">
          {#each shown as s (s.id)}
            {@const pc = pendingCount.get(s.id) ?? 0}
            <li>
              <a class="ios-cell row" class:has-pending={pc > 0} href={routeHref({ name: 'session', id: s.id })}>
                <span class="ios-cell-body">
                  <span class="line1">
                    <span class="title">{s.title || 'Без названия'}</span>
                    <span class="time">{relativeTime(s.mtime, app.now)}</span>
                  </span>
                  <span class="meta">
                    {#if s.open === true}
                      <span class="ios-tag">Активный</span>
                    {/if}
                    <span
                      class="ios-status {s.status}"
                      class:guess={s.open === true && s.openGuess}
                      title={s.open === true && s.openGuess ? OPEN_GUESS_HINT : undefined}
                      >{STATUS_LABEL[s.status] ?? s.status}</span
                    >
                    <span class="ios-sep" aria-hidden="true">·</span>
                    <span class="src">{SOURCE_LABEL[s.source] ?? s.source}</span>
                    {#if pc > 0}
                      <span class="ios-badge" aria-label="Ждут ответа: {pc}">{pc}</span>
                    {/if}
                  </span>
                </span>
                <span class="ios-chevron" aria-hidden="true"></span>
              </a>
            </li>
          {/each}
          {#if g.sessions.length > shown.length}
            <li>
              <button class="ios-cell tint" type="button" onclick={() => expanded.add(g.key)}>
                Показать ещё {g.sessions.length - shown.length}
              </button>
            </li>
          {/if}
        </ul>
      </section>
    {/each}
  </main>
</div>

<!-- Тонкая полоса под статус-баром: текст при прокрутке не наезжает на часы. Не ловит касания. -->
<div class="top-strip" aria-hidden="true"></div>

<a class="fab" href={routeHref({ name: 'new' })}>
  <svg class="ios-icon heavy" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
  Новая сессия
</a>
</div>

<style>
  .list {
    position: absolute;
    inset: 0;
  }
  .page {
    /* Список прокручивается сам, страница — нет: позиция сохраняется, пока открыта сессия. */
    position: absolute;
    inset: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    background: var(--bg);
    /* Сверху — под статус-баром, как у шапки. */
    padding-top: calc(var(--safe-top) + var(--s-2));
    /* Последняя строка докручивается выше кнопки: высота кнопки + зазор над ней + зазор под ней. */
    padding-bottom: calc(var(--tap) + var(--s-4) * 2 + var(--safe-bottom));
  }
  .top-strip {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: var(--safe-top);
    z-index: 10;
    pointer-events: none;
    background: var(--bg);
  }
  /* Плавающая кнопка «Новая сессия». */
  .fab {
    position: absolute;
    right: calc(var(--gutter) + var(--safe-right));
    bottom: calc(var(--safe-bottom) + var(--s-4));
    z-index: 11;
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    height: var(--tap);
    padding: 0 var(--s-4) 0 var(--s-3);
    border-radius: var(--radius-full);
    background: var(--accent);
    color: var(--accent-fg);
    font: var(--t-subhead);
    font-weight: var(--w-semibold);
    text-decoration: none;
    white-space: nowrap;
    box-shadow: var(--shadow);
  }
  .fab:active {
    opacity: 0.8;
  }
  main.settling {
    transition: transform 300ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @media (prefers-reduced-motion: reduce) {
    main.settling {
      transition: none;
    }
  }
  .ptr {
    position: absolute;
    top: -40px;
    left: 50%;
    width: var(--s-8);
    height: var(--s-8);
    margin-left: calc(var(--s-4) * -1);
    display: grid;
    place-items: center;
    color: var(--fg-muted);
    opacity: 0;
    pointer-events: none;
  }
  .ptr svg {
    transform: rotate(var(--ptr-turn, 0deg));
  }
  .ptr.spin svg {
    animation: ptr-spin 0.8s linear infinite;
  }
  @keyframes ptr-spin {
    to {
      transform: rotate(360deg);
    }
  }
  main {
    position: relative;
  }
  .empty {
    text-align: center;
    margin: var(--s-12) var(--gutter);
    color: var(--fg-muted);
  }
  .empty p {
    margin: 0 0 var(--s-1);
  }
  .row.has-pending {
    background: var(--accent-soft);
  }
  .row.has-pending .ios-tag {
    background: var(--bg-elev);
  }
  .row.has-pending:active {
    background: var(--cell-press);
  }
  /* Каждая строка одной высоты: заголовок в одну строку, значит метка, время и шеврон
     стоят на одних и тех же линиях во всех строках. */
  .line1 {
    display: flex;
    align-items: baseline;
    gap: var(--s-2);
    min-width: 0;
    height: var(--s-6);
  }
  .title {
    flex: 1;
    min-width: 0;
    font-weight: var(--w-semibold);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .time {
    flex: none;
    font: var(--t-subhead);
    font-variant-numeric: tabular-nums;
    color: var(--fg-muted);
    white-space: nowrap;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: var(--s-1);
    font: var(--t-subhead);
    color: var(--fg-muted);
    min-width: 0;
    white-space: nowrap;
  }
  .meta .ios-tag {
    margin-right: var(--s-1);
  }
  .src {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
