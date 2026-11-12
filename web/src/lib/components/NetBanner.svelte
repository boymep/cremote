<script lang="ts">
  import { app } from '../state.svelte';

  // Короткие переподключения (меньше секунды) не показываем, чтобы полоса не мигала.
  const DELAY_MS = 900;

  let visible = $state(false);
  let now = $state(Date.now());

  const net = $derived(app.net);

  $effect(() => {
    if (net === 'ok') {
      visible = false;
      return;
    }
    if (net === 'offline' || net === 'down' || !app.everSynced) {
      visible = true;
      return;
    }
    const t = setTimeout(() => (visible = true), DELAY_MS);
    return () => clearTimeout(t);
  });

  $effect(() => {
    if (!visible || app.retryAt == null) return;
    now = Date.now();
    const i = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(i);
  });

  const secs = $derived(app.retryAt == null ? null : Math.max(0, Math.ceil((app.retryAt - now) / 1000)));

  const text = $derived.by(() => {
    switch (net) {
      case 'offline':
        return 'Нет сети';
      case 'down':
        return 'Сервер недоступен';
      case 'connecting':
        return 'Подключаемся…';
      default:
        return 'Связь потеряна';
    }
  });
  const sub = $derived(
    net === 'offline' ? 'ждём подключения' : app.conn === 'connecting' || secs == null ? 'подключаемся…' : secs > 0 ? `повтор: ${secs} с` : 'подключаемся…',
  );
  const canRetry = $derived(net !== 'offline' && net !== 'connecting' && app.conn !== 'connecting');
</script>

{#if visible && net !== 'ok'}
  <div
    class="banner {net}"
    role="status"
    aria-live="polite"
    title={net === 'down' ? 'Mac, сервер cremote или туннель не отвечают' : undefined}
  >
    <span class="ios-dot" aria-hidden="true"></span>
    <span class="text">
      <span class="main">{text}</span>
      {#if sub && net !== 'connecting'}<span class="sub">· {sub}</span>{/if}
    </span>
    {#if canRetry}
      <button class="retry" type="button" onclick={() => app.reconnectNow()}>Повторить</button>
    {/if}
  </div>
{/if}

<style>
  .banner {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--s-2);
    height: var(--tap);
    padding: 0 calc(var(--gutter) + var(--safe-right)) 0 calc(var(--gutter) + var(--safe-left));
    font: var(--t-subhead);
    background: var(--warn-soft);
    color: var(--fg);
    overflow: hidden;
  }
  .banner.down,
  .banner.offline {
    background: var(--danger-soft);
  }
  .banner.connecting {
    background: var(--bg-sunken);
    color: var(--fg-muted);
  }
  .ios-dot {
    color: var(--warn);
    animation: pulse 1.2s ease-in-out infinite;
  }
  .down .ios-dot,
  .offline .ios-dot {
    color: var(--danger);
    animation: none;
  }
  .connecting .ios-dot {
    color: var(--fg-faint);
  }
  .text {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .main {
    font-weight: var(--w-semibold);
  }
  .sub {
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
  }
  /* Капсула 32, зона нажатия 44 за счёт псевдоэлемента. */
  .retry {
    flex: none;
    position: relative;
    height: var(--s-8);
    padding: 0 var(--s-3);
    border-radius: var(--radius-full);
    border: 0;
    background: var(--fill);
    color: var(--accent);
    font: var(--t-footnote);
    font-weight: var(--w-semibold);
    cursor: pointer;
  }
  .retry::after {
    content: '';
    position: absolute;
    inset: -6px 0;
  }
  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }
</style>
