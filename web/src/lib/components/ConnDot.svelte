<script lang="ts">
  import { app } from '../state.svelte';

  // Только точка фиксированного размера: подробности показывает NetBanner, шапка не прыгает.
  const LABEL = {
    ok: 'на связи',
    connecting: 'подключение',
    reconnecting: 'переподключение',
    offline: 'нет сети',
    down: 'сервер недоступен',
  } as const;
  const net = $derived(app.net);
</script>

<span class="conn {net}" role="img" title={LABEL[net]} aria-label="Связь: {LABEL[net]}">
  <span class="ios-dot"></span>
</span>

<style>
  /* Зона 44 как у кнопок панели: точка стоит на гуттере экрана. */
  .conn {
    flex: none;
    display: inline-grid;
    place-items: center end;
    width: var(--tap);
    height: var(--tap);
    padding-right: var(--nav-btn-px);
  }
  .ios-dot {
    color: var(--ok);
  }
  .connecting .ios-dot,
  .reconnecting .ios-dot {
    color: var(--warn);
    animation: pulse 1s ease-in-out infinite;
  }
  .offline .ios-dot,
  .down .ios-dot {
    color: var(--danger);
  }
  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }
</style>
