<script lang="ts">
  import { onDestroy } from 'svelte';
  import { app } from '../state.svelte';
  import { haptic } from '../haptics';
  import { Attachments } from '../attachments.svelte';
  import type { SessionInfo } from '../protocol';
  import AttachmentStrip from './AttachmentStrip.svelte';

  let { sessionId, session }: { sessionId: string; session?: SessionInfo } = $props();

  const draftKey = $derived(`cremote:draft:${sessionId}`);
  let text = $state('');
  let sending = $state(false);
  let stopping = $state(false);
  let ta: HTMLTextAreaElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();
  const att = new Attachments();
  /** 6 строк по 24px плюс вертикальные отступы поля. */
  const MAX_TA_PX = 160;

  $effect.pre(() => {
    text = sessionStorage.getItem(draftKey) ?? '';
  });

  $effect(() => {
    if (text) sessionStorage.setItem(draftKey, text);
    else sessionStorage.removeItem(draftKey);
  });

  $effect(() => {
    void text;
    if (!ta) return;
    ta.style.height = 'auto';
    // До ~6 строк растёт, дальше прокручивается внутри.
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_TA_PX)}px`;
  });

  onDestroy(() => att.clear());

  const status = $derived(session?.status);
  /**
   * Сессия жива в VS Code или CLI. working — сообщение встаёт в очередь, Claude получит его после
   * ближайшего вызова инструмента или в конце ответа; idle/live — async-хук Wait будит Claude сразу.
   */
  const liveHook = $derived(
    !!session &&
      session.source !== 'sdk' &&
      (status === 'live' || status === 'working' || status === 'idle' || status === 'awaiting_input'),
  );
  /** Вкладка открыта, но хуки о ней ничего не сообщали: открыта до `cremote install`, сообщение не дойдёт. */
  const noHooks = $derived(!!session && session.source !== 'sdk' && session.open === true && status === 'history');
  const blocked = $derived<string | null>(noHooks ? 'Перезагрузите окно VS Code, чтобы писать с телефона' : null);
  const canStop = $derived(status === 'working');
  const resumes = $derived(!!session && !liveHook && status !== 'live' && status !== 'working');
  const online = $derived(app.conn === 'open' && app.synced);
  const canSend = $derived(
    online && !blocked && !sending && !att.uploading && (text.trim() !== '' || att.ids.length > 0),
  );

  async function send() {
    if (!canSend) return;
    haptic();
    sending = true;
    try {
      await app.request({ type: 'send_message', sessionId, text: text.trim(), attachments: att.ids });
      text = '';
      att.clear();
    } catch (e) {
      app.toast((e as Error).message, 'error');
    } finally {
      sending = false;
    }
  }

  async function stop() {
    stopping = true;
    try {
      await app.request({ type: 'interrupt', sessionId });
      app.toast('Остановка запрошена');
    } catch (e) {
      app.toast((e as Error).message, 'error');
    } finally {
      stopping = false;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  }
</script>

<div class="composer">
  {#if blocked}
    <div class="blocked">
      <span class="why">{blocked}</span>
      {#if canStop}
        <button class="btn btn-destructive" disabled={stopping || !online} onclick={stop}>Стоп</button>
      {/if}
    </div>
  {:else}
    <AttachmentStrip {att} />
    <div class="row">
      <button class="icon-btn attach" type="button" aria-label="Прикрепить картинку" onclick={() => fileInput?.click()}>
        <svg class="ios-icon" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"
          ><path
            d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"
          /></svg
        >
      </button>
      <input
        bind:this={fileInput}
        class="sr-only"
        type="file"
        accept="image/*"
        multiple
        onchange={(e) => {
          att.add(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
      <textarea
        bind:this={ta}
        bind:value={text}
        class="input"
        rows="1"
        placeholder={resumes ? 'Продолжить…' : 'Сообщение'}
        aria-label="Сообщение"
        enterkeyhint="enter"
        onkeydown={onKey}
      ></textarea>
      {#if canStop}
        <button class="icon-btn" aria-label="Стоп" disabled={stopping || !online} onclick={stop}>
          <span class="circle stop"
            ><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"
              ><rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" /></svg
            ></span
          >
        </button>
      {/if}
      <button class="icon-btn" aria-label="Отправить" disabled={!canSend} onclick={send}>
        <span class="circle send"
          ><svg class="ios-icon heavy" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"
            ><path d="M12 19.5V5M5.5 11.5L12 5l6.5 6.5" /></svg
          ></span
        >
      </button>
    </div>
  {/if}
</div>

<style>
  /* Панель ввода: значок вложения и кнопка отправки стоят на гуттере экрана, их зоны нажатия
     (44) выходят за него. Поля панели — гуттер минус поле значка внутри зоны: 16 − 10 и 16 − 6. */
  .composer {
    --attach-inset: calc((var(--tap) - var(--icon-lg)) / 2);
    --send-inset: calc((var(--tap) - var(--s-8)) / 2);
    position: relative;
    z-index: 2;
    padding: var(--s-1) calc(var(--gutter) - var(--send-inset) + var(--safe-right))
      calc(var(--s-1) + var(--kb-safe-bottom, var(--safe-bottom))) calc(var(--gutter) - var(--attach-inset) + var(--safe-left));
    background: var(--bg);
    box-shadow: 0 -0.5px 0 var(--border-strong);
  }
  @supports ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) {
    .composer {
      background: color-mix(in srgb, var(--bg-elev) 72%, transparent);
      -webkit-backdrop-filter: saturate(180%) blur(20px);
      backdrop-filter: saturate(180%) blur(20px);
    }
  }
  /* Ряд высотой 44; растёт только поле, кнопки остаются на нижней линии. */
  .row {
    display: flex;
    align-items: flex-end;
  }
  /* Поле 40 в ряду 44: поля 2 сверху и снизу дают общий центр с кнопками. Рамка — внутренней
     тенью, чтобы scrollHeight (высота поля в скрипте) совпадал с внешней высотой.
     Боковые поля дают видимый зазор 8 и до значка (10 − 2), и до кнопки (6 + 2). */
  .input {
    flex: 1;
    min-width: 0;
    min-height: 40px;
    max-height: 160px;
    margin: 2px 2px 2px -2px;
    padding: var(--s-2) var(--s-4);
    border: 0;
    border-radius: var(--radius-bubble);
    box-shadow: inset 0 0 0 1px var(--border-strong);
    background: var(--bg);
    color: var(--fg);
    font: var(--t-callout);
    resize: none;
    display: block;
  }
  .input:focus {
    outline: none;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 60%, var(--border-strong));
  }
  .input::placeholder {
    color: var(--fg-faint);
  }
  .icon-btn {
    flex: none;
    position: relative;
    display: grid;
    place-items: center;
    width: var(--tap);
    height: var(--tap);
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  .icon-btn:active:not(:disabled) {
    opacity: 0.5;
  }
  .icon-btn:disabled {
    cursor: default;
  }
  .attach:disabled {
    opacity: 0.4;
  }
  .circle {
    display: grid;
    place-items: center;
    width: var(--s-8);
    height: var(--s-8);
    border-radius: 50%;
  }
  .send {
    background: var(--accent);
    color: var(--accent-fg);
  }
  .icon-btn:disabled .send {
    background: var(--border-strong);
    color: var(--bg);
  }
  .stop {
    background: color-mix(in srgb, var(--danger) 16%, transparent);
    color: var(--danger);
  }
  .icon-btn:disabled .stop {
    opacity: 0.5;
  }
  .blocked {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
    min-height: var(--tap);
    padding: 0 var(--send-inset) 0 var(--attach-inset);
  }
  .why {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--fg-muted);
    font: var(--t-subhead);
  }
  /* Вложения над полем: левый край совпадает с полем, правый — с кнопкой отправки. */
  .composer :global(.strip) {
    padding: var(--s-2) var(--send-inset) var(--s-1) calc(var(--tap) - 2px);
  }
</style>
