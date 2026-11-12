<script lang="ts">
  // Экран «Настройки» (#/settings): аккаунт и лимиты, уведомления, установка, о приложении.
  import { app, routeHref } from '../state.svelte';
  import AccountsBlock from './AccountsBlock.svelte';
  import PushToggle from './PushToggle.svelte';
  import NetBanner from './NetBanner.svelte';
  import { haptic } from '../haptics';

  const NET_LABEL = {
    ok: 'На связи',
    connecting: 'Подключаемся…',
    reconnecting: 'Переподключаемся…',
    offline: 'Нет сети',
    down: 'Сервер недоступен',
  } as const;

  let scrolled = $state(false);
  let confirmLogout = $state(false);
  let build = $state('');

  // Id сборки vite-плагин записывает в sw.js (Date.now() в base36) — из него же берём дату сборки.
  $effect(() => {
    let alive = true;
    fetch('/sw.js', { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => {
        const id = /const BUILD_ID = '([^']+)'/.exec(t)?.[1] ?? '';
        if (!alive || !id) return;
        if (id.startsWith('__')) {
          build = 'dev';
          return;
        }
        const ms = parseInt(id, 36);
        const when = Number.isFinite(ms)
          ? new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ms)
          : '';
        build = when ? `${id} · ${when}` : id;
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  });

  function onScroll(e: Event) {
    scrolled = (e.currentTarget as HTMLElement).scrollTop > 30;
  }

  function logout() {
    haptic();
    void app.logout();
  }
</script>

<div class="screen" onscroll={onScroll}>
  <div class="ios-nav" class:scrolled>
    <div class="ios-nav-row">
      <div class="ios-nav-left">
        <a
          class="ios-nav-btn back"
          href={routeHref({ name: 'list' })}
          onclick={(e) => {
            e.preventDefault();
            app.back();
          }}
        >
          <svg class="ios-icon heavy" width="12" height="24" viewBox="0 0 12 24" aria-hidden="true"><path d="M10 4l-8 8 8 8" /></svg>
          Сессии
        </a>
      </div>
      <span class="ios-nav-title" style:opacity={scrolled ? 1 : 0} aria-hidden="true">Настройки</span>
      <div class="ios-nav-right"></div>
    </div>
    <NetBanner />
  </div>

  <h1 class="ios-large-title">Настройки</h1>

  <div class="content">
    {#if app.accounts}
      <AccountsBlock />
    {:else}
      <section class="ios-section">
        <h2 class="ios-section-header">Аккаунт</h2>
        <div class="ios-list"><div class="ios-cell"><span class="muted">Данные аккаунта ещё не пришли</span></div></div>
      </section>
    {/if}

    <PushToggle />

    <section class="ios-section" aria-labelledby="about-h">
      <h2 class="ios-section-header" id="about-h">О приложении</h2>
      <ul class="ios-list">
        <li>
          <div class="ios-cell">
            <span class="ios-cell-body">Соединение</span>
            <span class="ios-cell-value conn {app.net}"><span class="ios-dot" aria-hidden="true"></span>{NET_LABEL[app.net]}</span>
          </div>
        </li>
        {#if app.net !== 'ok'}
          <li>
            <button class="ios-cell tint" type="button" onclick={() => app.reconnectNow()}>Переподключиться</button>
          </li>
        {/if}
        {#if app.update}
          <li>
            <div class="ios-cell">
              <span class="ios-cell-body">Версия</span>
              <span class="ios-cell-value num">cremote {app.update.current}</span>
            </div>
          </li>
        {/if}
        {#if build}
          <li>
            <div class="ios-cell">
              <span class="ios-cell-body">Сборка</span>
              <span class="ios-cell-value num">{build}</span>
            </div>
          </li>
        {/if}
      </ul>
    </section>

    <section class="ios-section">
      <ul class="ios-list">
        <li>
          {#if confirmLogout}
            <div class="ios-confirm">
              <span class="ios-confirm-q center">Выйти из cremote на этом устройстве?</span>
              <span class="btn-row">
                <button class="btn btn-tint" type="button" onclick={() => (confirmLogout = false)}>Отмена</button>
                <button class="btn btn-danger" type="button" onclick={logout}>Выйти</button>
              </span>
            </div>
          {:else}
            <button class="ios-cell destructive center" type="button" onclick={() => (confirmLogout = true)}>Выйти</button>
          {/if}
        </li>
      </ul>
    </section>
  </div>
</div>

<style>
  .screen {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    background: var(--bg);
  }
  .content {
    padding-bottom: var(--safe-bottom);
  }
  .conn {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
  }
  .conn .ios-dot {
    color: var(--ok);
  }
  .conn.connecting .ios-dot,
  .conn.reconnecting .ios-dot {
    color: var(--warn);
  }
  .conn.offline .ios-dot,
  .conn.down .ios-dot {
    color: var(--danger);
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .center {
    text-align: center;
  }
</style>
