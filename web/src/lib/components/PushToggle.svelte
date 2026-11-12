<script lang="ts">
  import { app } from '../state.svelte';
  import { disablePush, enablePush, pushState, sendTestPush } from '../pwa';

  type St = Awaited<ReturnType<typeof pushState>>;

  let st = $state<St>('unsupported');
  let busy = $state(false);

  async function refresh(): Promise<void> {
    st = await pushState();
  }
  void refresh();

  const footer = $derived(
    {
      unsupported: 'Этот браузер не поддерживает push-уведомления.',
      'needs-install': 'Уведомления доступны после установки на экран «Домой».',
      denied: 'Уведомления запрещены. Разрешите их в Настройках iOS → Уведомления → cremote.',
      off: 'Сообщим, когда Claude ждёт ответа или закончил работу.',
      on: 'Сообщим, когда Claude ждёт ответа или закончил работу.',
    }[st],
  );
  const canToggle = $derived(st === 'on' || st === 'off');

  // Обработчик вызывает enablePush синхронно: iOS требует жест пользователя
  async function run(fn: () => Promise<void>): Promise<void> {
    busy = true;
    try {
      await fn();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Не удалось выполнить действие', 'error');
    } finally {
      busy = false;
      await refresh();
    }
  }
  // Переключатель: включение идёт в том же обработчике события (жест пользователя для iOS).
  function onToggle(e: Event & { currentTarget: HTMLInputElement }): void {
    const el = e.currentTarget;
    // Переключатель сдвигается сразу, а после ответа встаёт по фактическому состоянию.
    void run(el.checked ? enablePush : disablePush).then(() => (el.checked = st === 'on'));
  }
  const onTest = (): Promise<void> => run(sendTestPush);
</script>

<section class="ios-section" aria-labelledby="push-h">
  <h2 class="ios-section-header" id="push-h">Уведомления</h2>
  <ul class="ios-list">
    <li>
      <label class="ios-cell">
        <span class="ios-cell-body">Push-уведомления</span>
        {#if busy}<span class="ios-spinner" aria-hidden="true"></span>{/if}
        <input
          class="ios-switch"
          type="checkbox"
          role="switch"
          checked={st === 'on'}
          disabled={!canToggle || busy}
          onchange={onToggle}
        />
      </label>
    </li>
    {#if st === 'on'}
      <li>
        <button class="ios-cell tint" type="button" disabled={busy} onclick={onTest}>Отправить тестовое</button>
      </li>
    {/if}
  </ul>
  <p class="ios-section-footer">{footer}</p>
</section>
