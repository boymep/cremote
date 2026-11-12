<script lang="ts">
  import { app } from './lib/state.svelte';
  import { unlockAudio } from './lib/notify';
  import Login from './lib/components/Login.svelte';
  import SessionList from './lib/components/SessionList.svelte';
  import SessionView from './lib/components/SessionView.svelte';
  import NewSession from './lib/components/NewSession.svelte';
  import Settings from './lib/components/Settings.svelte';
  import FileViewer from './lib/components/FileViewer.svelte';
  import Toasts from './lib/components/Toasts.svelte';
  import { haptic } from './lib/haptics';

  $effect(() => {
    const n = app.pending.length;
    document.title = n > 0 ? `(${n}) cremote` : 'cremote';
  });

  // Без слушателя touchstart iOS не включает :active — нет отклика на нажатие.
  $effect(() => {
    const noop = () => {};
    document.addEventListener('touchstart', noop, { passive: true });
    return () => document.removeEventListener('touchstart', noop);
  });

  // ---------- Свайп назад от левого края ----------
  // Список остаётся смонтированным под экраном сессии (скрыт), поэтому при жесте он виден
  // сразу, а позиция прокрутки списка сохраняется между переходами.

  const EDGE = 24; // ширина зоны у левого края, px
  const PARALLAX = 0.3; // на сколько ширины сдвинут нижний экран
  const DIM = 0.18; // затемнение нижнего экрана в начале жеста
  const SETTLE = 'transform 300ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 300ms cubic-bezier(0.2, 0.8, 0.2, 1)';

  let underEl: HTMLDivElement | undefined = $state();
  let shadeEl: HTMLDivElement | undefined = $state();
  /** Нижний экран (список) показан во время жеста. */
  let peeking = $state(false);
  const covered = $derived(app.route.name !== 'list' && !peeking);

  // Маршрут сменился (в том числе после свайпа) — снимаем следы жеста с нижнего экрана.
  $effect(() => {
    void app.route;
    if (underEl) {
      underEl.style.transform = '';
      underEl.style.transition = '';
    }
    peeking = false;
  });

  function swipeBack(node: HTMLElement) {
    let phase: 'idle' | 'maybe' | 'drag' | 'settling' = 'idle';
    let touchId = -1;
    let startX = 0;
    let startY = 0;
    let width = 1;
    let x = 0;
    let lastX = 0;
    let lastT = 0;
    let vx = 0;

    const apply = (pos: number) => {
      x = Math.max(0, Math.min(width, pos));
      const p = x / width;
      node.style.transform = `translate3d(${x}px, 0, 0)`;
      if (underEl) underEl.style.transform = `translate3d(${-PARALLAX * width * (1 - p)}px, 0, 0)`;
      if (shadeEl) shadeEl.style.opacity = String(DIM * (1 - p));
    };
    const setTransition = (v: string) => {
      node.style.transition = v;
      if (underEl) underEl.style.transition = v;
      if (shadeEl) shadeEl.style.transition = v;
    };
    const clear = () => {
      node.style.transform = '';
      node.style.transition = '';
      node.style.boxShadow = '';
      if (shadeEl) {
        shadeEl.style.opacity = '';
        shadeEl.style.transition = '';
      }
      if (underEl) {
        underEl.style.transform = '';
        underEl.style.transition = '';
      }
      peeking = false;
    };
    const touchOf = (e: TouchEvent) => Array.from(e.changedTouches).find((t) => t.identifier === touchId);
    const hasSelection = () => {
      const sel = window.getSelection();
      return !!sel && !sel.isCollapsed;
    };

    const onStart = (e: TouchEvent) => {
      if (phase !== 'idle' || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (t.clientX > EDGE || hasSelection()) return;
      phase = 'maybe';
      touchId = t.identifier;
      startX = lastX = t.clientX;
      startY = t.clientY;
      lastT = e.timeStamp;
      vx = 0;
    };

    const onMove = (e: TouchEvent) => {
      if (phase !== 'maybe' && phase !== 'drag') return;
      const t = touchOf(e);
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (phase === 'maybe') {
        if (hasSelection() || dx < -4 || (Math.abs(dy) > 6 && Math.abs(dy) > dx)) {
          phase = 'idle';
          return;
        }
        // Движение вправо от края: сразу забираем жест, чтобы не поехал код-блок или выделение.
        if (e.cancelable) e.preventDefault();
        if (dx < 8) return;
        phase = 'drag';
        width = node.clientWidth || window.innerWidth;
        startX = t.clientX;
        peeking = true;
        setTransition('none');
        node.style.boxShadow = '-6px 0 24px rgb(0 0 0 / 0.18)';
      }
      if (e.cancelable) e.preventDefault();
      const dt = e.timeStamp - lastT;
      if (dt > 0) vx = 0.7 * ((t.clientX - lastX) / dt) + 0.3 * vx;
      lastX = t.clientX;
      lastT = e.timeStamp;
      apply(t.clientX - startX);
    };

    const finish = (commit: boolean) => {
      phase = 'settling';
      setTransition(SETTLE);
      apply(commit ? width : 0);
      let done = false;
      const end = () => {
        if (done) return;
        done = true;
        node.removeEventListener('transitionend', onEnd);
        if (commit) {
          // Экран уже уехал: возвращаемся без второй анимации. Следы жеста снимет смена маршрута.
          app.back({ animate: false });
        } else {
          clear();
        }
        phase = 'idle';
      };
      const onEnd = (ev: TransitionEvent) => {
        if (ev.target === node && ev.propertyName === 'transform') end();
      };
      node.addEventListener('transitionend', onEnd);
      setTimeout(end, 380);
    };

    const onEnd = (e: TouchEvent) => {
      if (!touchOf(e)) return;
      if (phase === 'maybe') {
        phase = 'idle';
        return;
      }
      if (phase !== 'drag') return;
      // Если жест сорвался (touchcancel) — возвращаем экран; иначе решают путь и скорость.
      const commit =
        e.type === 'touchend' && vx > -0.2 && (x > width * 0.35 || (vx > 0.5 && x > 24));
      if (commit) {
        haptic();
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      finish(commit);
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

<svelte:window onpointerdown={unlockAudio} onkeydown={unlockAudio} />

{#if app.auth === 'checking'}
  <div class="splash" aria-busy={app.net === 'connecting'}>
    <img src="/icon.svg" alt="" width="56" height="56" />
    <!-- Строка статуса занимает место всегда, чтобы иконка не прыгала. -->
    <div class="splash-status" role="status" aria-live="polite">
      {#if app.net === 'down'}
        <p>Сервер недоступен: Mac или туннель не отвечают.</p>
        <button class="btn" onclick={() => app.reconnectNow()}>Повторить</button>
      {:else if app.net === 'offline'}
        <p>Нет сети. Подключимся, когда она появится.</p>
      {:else}
        <p class="muted">Подключаемся…</p>
      {/if}
    </div>
  </div>
{:else if app.auth === 'login'}
  <Login />
{:else}
  <!-- Список смонтирован всегда: под экраном сессии он скрыт и сохраняет прокрутку. -->
  <div class="layer under" class:covered bind:this={underEl} inert={covered} aria-hidden={covered}>
    <SessionList />
  </div>
  {#if app.route.name !== 'list'}
    <div class="shade" bind:this={shadeEl} aria-hidden="true"></div>
    <div class="layer top" class:chat={app.route.name === 'session'} {@attach swipeBack}>
      {#if app.route.name === 'session'}
        {#key app.route.id}
          <SessionView sessionId={app.route.id} />
        {/key}
      {:else if app.route.name === 'settings'}
        <Settings />
      {:else}
        <NewSession />
      {/if}
    </div>
  {/if}
{/if}

{#if app.auth === 'ok'}<FileViewer />{/if}
<Toasts />

<style>
  .splash {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--s-4);
    padding: var(--safe-top) calc(var(--gutter) + var(--safe-right)) var(--safe-bottom) calc(var(--gutter) + var(--safe-left));
    text-align: center;
  }
  .splash-status {
    min-height: 96px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s-3);
    font: var(--t-subhead);
  }
  .splash-status p {
    margin: 0;
  }
  /* Экраны — слои на весь экран; прокручиваются только их внутренние области. */
  .layer {
    position: fixed;
    inset: 0;
    overflow: hidden;
    background: var(--bg);
  }
  /* Установленное приложение: fixed + inset: 0 на iOS не доходит до самого низа (под полоску
     «домой»), снизу остаётся пустая полоса. Растягиваем слой на всю высоту экрана явно. Экран
     сессии не трогаем: его высоту задаёт видимая область (lib/viewport.ts). */
  @media (display-mode: standalone) {
    .layer:not(.chat) {
      bottom: auto;
      height: 100lvh;
    }
  }
  .under {
    z-index: 0;
  }
  .under.covered {
    visibility: hidden;
  }
  .shade {
    position: fixed;
    inset: 0;
    z-index: 1;
    background: #000;
    opacity: 0;
    pointer-events: none;
  }
  .top {
    z-index: 2;
  }
</style>
