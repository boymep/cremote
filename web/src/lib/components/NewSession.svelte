<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { app, routeHref } from '../state.svelte';
  import { Attachments } from '../attachments.svelte';
  import { DEFAULT_NEW_SESSION_MODE, PERMISSION_MODES, type ModelOption, type PermissionMode } from '../protocol';
  import { basename, shortPath } from '../format';
  import AttachmentStrip from './AttachmentStrip.svelte';
  import NetBanner from './NetBanner.svelte';

  let projects = $state<string[]>([]);
  let projectsError = $state<string | null>(null);
  let loadingProjects = $state(true);
  let cwd = $state('');
  let mode = $state<PermissionMode>(DEFAULT_NEW_SESSION_MODE);
  let model = $state('');
  let models = $state<ModelOption[]>([]);
  let loadingModels = $state(true);
  // Только алиасы (opus, sonnet, fable, haiku…) в порядке SDK: без закреплённых версий вида claude-…
  // и без «default» — его роль играет первый пункт «Default».
  const aliasModels = $derived(
    models.filter((m) => m.value !== 'default' && !m.value.startsWith('claude-') && !/\d/.test(m.value)),
  );
  const modelHint = $derived.by(() => {
    if (loadingModels && models.length === 0) return 'Загружаем список моделей…';
    if (!model) return models.find((m) => m.value === 'default')?.description || 'Модель аккаунта по умолчанию';
    return models.find((m) => m.value === model)?.description ?? '';
  });
  let text = $state('');
  let busy = $state(false);
  let fileInput: HTMLInputElement | undefined = $state();
  const att = new Attachments();

  async function loadProjects() {
    loadingProjects = true;
    projectsError = null;
    try {
      projects = await app.api.projects();
      if (!cwd && projects.length > 0) cwd = projects[0];
    } catch (e) {
      projectsError = (e as Error).message;
    } finally {
      loadingProjects = false;
    }
  }
  async function loadModels() {
    loadingModels = true;
    try {
      models = await app.api.models();
    } catch {
      // Без списка остаётся только «Default»: сессия запустится с моделью аккаунта.
      models = [];
    } finally {
      loadingModels = false;
    }
  }
  onMount(() => {
    void loadProjects();
    void loadModels();
  });
  // Связь вернулась, а проекты не загрузились: пробуем снова.
  let prevNet = app.net;
  $effect(() => {
    const n = app.net;
    if (n === 'ok' && prevNet !== 'ok') untrack(() => projectsError && !loadingProjects && void loadProjects());
    prevNet = n;
  });
  onDestroy(() => {
    att.clear();
    app.cancelCreate();
  });

  const waiting = $derived(app.creating !== null);
  const canCreate = $derived(
    app.net === 'ok' &&
      cwd.trim().startsWith('/') &&
      (text.trim() !== '' || att.ids.length > 0) &&
      !att.uploading &&
      !busy &&
      !waiting,
  );

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!canCreate) return;
    busy = true;
    const dir = cwd.trim();
    app.beginCreate(dir);
    try {
      await app.request(
        {
          type: 'create_session',
          cwd: dir,
          text: text.trim(),
          attachments: att.ids,
          permissionMode: mode,
          ...(model ? { model } : {}),
        },
        60_000,
      );
    } catch (err) {
      app.cancelCreate();
      app.toast((err as Error).message, 'error');
    } finally {
      busy = false;
    }
  }

  let screen: HTMLDivElement | undefined = $state();
  let scrolled = $state(false);
  // Мало моделей — сегменты, как UISegmentedControl; много — системное меню выбора.
  const useSegments = $derived(aliasModels.length > 0 && aliasModels.length <= 3);
  const showProjects = $derived(projects.slice(0, 12));
  let bar: HTMLDivElement | undefined = $state();

  // Поле в фокусе держим в видимой части: контейнер сжимается до области над клавиатурой,
  // и iOS сам не всегда докручивает его до поля.
  function keepFocusedVisible() {
    const el = document.activeElement;
    if (!screen || !(el instanceof HTMLElement) || !screen.contains(el) || !el.matches('input, textarea, select')) return;
    const r = el.getBoundingClientRect();
    const box = screen.getBoundingClientRect();
    const top = bar ? bar.getBoundingClientRect().bottom : box.top;
    const gap = 12;
    if (r.bottom > box.bottom - gap) screen.scrollTop += Math.min(r.bottom - box.bottom + gap, r.top - top - gap);
    else if (r.top < top + gap) screen.scrollTop -= top + gap - r.top;
  }
  let keepRaf = 0;
  function scheduleKeepFocused() {
    cancelAnimationFrame(keepRaf);
    keepRaf = requestAnimationFrame(keepFocusedVisible);
  }
  $effect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    vv.addEventListener('resize', scheduleKeepFocused);
    return () => {
      vv.removeEventListener('resize', scheduleKeepFocused);
      cancelAnimationFrame(keepRaf);
    };
  });

  // Если сессия долго не появляется в списке, возвращаемся к нему.
  $effect(() => {
    if (!waiting) return;
    const t = setTimeout(() => {
      if (app.creating) {
        app.cancelCreate();
        app.toast('Сессия запущена, но ещё не появилась в списке');
        app.back();
      }
    }, 45_000);
    return () => clearTimeout(t);
  });
</script>

<!-- Прокручивается только этот контейнер; высота — видимая область над клавиатурой (lib/viewport.ts). -->
<div
  class="screen"
  bind:this={screen}
  onfocusin={scheduleKeepFocused}
  onscroll={(e) => (scrolled = e.currentTarget.scrollTop > 4)}
>
<div class="ios-nav solid" class:scrolled bind:this={bar}>
  <div class="ios-nav-row">
    <div class="ios-nav-left">
      <a
        class="ios-nav-btn"
        href={routeHref({ name: 'list' })}
        onclick={(e) => {
          e.preventDefault();
          app.back();
        }}>Отмена</a
      >
    </div>
    <h1 class="ios-nav-title">Новая сессия</h1>
    <div class="ios-nav-right">
      {#if waiting}
        <span class="ios-nav-btn" role="status" aria-label="Запускаем сессию"><span class="ios-spinner" aria-hidden="true"></span></span>
      {:else}
        <button class="ios-nav-btn strong" type="submit" form="new-session" disabled={!canCreate}>Создать</button>
      {/if}
    </div>
  </div>
  <NetBanner />
</div>

<div class="page">
  <form id="new-session" onsubmit={create}>
    <section class="ios-section">
      <h2 class="ios-section-header">Проект</h2>
      <ul class="ios-list projects">
        {#if loadingProjects}
          <li><div class="ios-cell"><span class="muted">Загружаем проекты…</span></div></li>
        {:else if projectsError}
          <li><div class="ios-cell"><span class="err">Не удалось загрузить проекты: {projectsError}</span></div></li>
        {/if}
        {#each showProjects as p (p)}
          <li>
            <label class="ios-cell">
              <input class="sr-only" type="radio" name="proj" value={p} bind:group={cwd} />
              <span class="ios-cell-body">
                <span class="ios-cell-title">{basename(p)}</span>
                <span class="ios-cell-sub mono-sub">{shortPath(p)}</span>
              </span>
              <span class="ios-check" class:off={cwd !== p} aria-hidden="true"></span>
            </label>
          </li>
        {/each}
        <li>
          <label class="ios-cell path">
            <span class="plabel">Путь</span>
            <input
              id="cwd"
              class="ios-input mono"
              type="text"
              bind:value={cwd}
              placeholder="/Users/…/project"
              autocapitalize="off"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
        </li>
      </ul>
    </section>

    <section class="ios-section">
      <h2 class="ios-section-header">Режим</h2>
      <ul class="ios-list">
        {#each PERMISSION_MODES as m (m.value)}
          <li>
            <label class="ios-cell mode" class:muted-mode={m.muted}>
              <input class="sr-only" type="radio" name="mode" value={m.value} bind:group={mode} />
              <span class="ios-cell-body">
                <span class="mname">{m.label}</span>
                <span class="mhint">{m.hint}</span>
              </span>
              <span class="ios-check" class:off={mode !== m.value} aria-hidden="true"></span>
            </label>
          </li>
        {/each}
      </ul>
    </section>

    <section class="ios-section">
      <h2 class="ios-section-header" id="model-h">Модель</h2>
      {#if useSegments}
        <div class="ios-segmented" role="radiogroup" aria-labelledby="model-h">
          <!-- «Default» — модель не передаётся, Claude Code берёт модель аккаунта. -->
          <label><input type="radio" name="model" value="" bind:group={model} />Default</label>
          {#each aliasModels as m (m.value)}
            <label><input type="radio" name="model" value={m.value} bind:group={model} />{m.displayName}</label>
          {/each}
        </div>
      {:else}
        <ul class="ios-list">
          <li>
            <label class="ios-cell">
              <span class="ios-cell-body">Модель</span>
              <select
                class="select"
                aria-labelledby="model-h"
                bind:value={model}
                disabled={loadingModels && models.length === 0}
              >
                <!-- «Default» — модель не передаётся, Claude Code берёт модель аккаунта. -->
                <option value="">Default</option>
                {#each aliasModels as m (m.value)}
                  <option value={m.value}>{m.displayName}</option>
                {/each}
              </select>
              <span class="ios-chevron updown" aria-hidden="true"></span>
            </label>
          </li>
        </ul>
      {/if}
      {#if modelHint}<p class="ios-section-footer">{modelHint}</p>{/if}
    </section>

    <section class="ios-section">
      <h2 class="ios-section-header"><label for="msg">Первое сообщение</label></h2>
      <ul class="ios-list">
        <li>
          <div class="ios-cell msg">
            <textarea id="msg" class="ios-input" rows="5" bind:value={text} placeholder="Что нужно сделать?"></textarea>
            <AttachmentStrip {att} />
          </div>
        </li>
        <li>
          <button class="ios-cell tint" type="button" onclick={() => fileInput?.click()}>
            <svg class="ios-icon" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"
              ><rect x="3" y="5" width="18" height="14" rx="2.5" /><circle cx="8.5" cy="10" r="1.6" /><path
                d="M4 17l5-5 4 4 3-3 4 4"
              /></svg
            >
            Прикрепить файл
          </button>
        </li>
      </ul>
      <input
        bind:this={fileInput}
        class="sr-only"
        type="file"
        accept="image/*,*/*"
        multiple
        onchange={(e) => {
          att.add(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
    </section>

    <div class="ios-section">
      <button class="ios-btn-filled" type="submit" disabled={!canCreate}>
        {waiting ? 'Запускаем сессию…' : 'Начать'}
      </button>
    </div>
  </form>
</div>
</div>

<style>
  .screen {
    position: absolute;
    left: 0;
    right: 0;
    top: var(--vvt, 0px);
    height: var(--vvh, 100%);
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    background: var(--bg);
  }
  /* Панель над формой: «стекло» только когда под ней есть содержимое. */
  .ios-nav.solid:not(.scrolled) {
    box-shadow: none;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
    background: var(--bg);
  }
  .page {
    padding: var(--s-4) 0 var(--safe-bottom);
  }
  form {
    margin: 0;
  }
  .err {
    color: var(--danger);
    font: var(--t-subhead);
  }
  .mono-sub {
    font: var(--t-mono);
  }
  .path {
    cursor: text;
  }
  .path:active {
    background: none;
  }
  .plabel {
    flex: none;
    width: var(--s-12);
  }
  /* 16px: iOS не зумит страницу при фокусе. */
  .path .ios-input {
    font: var(--t-callout);
    font-family: var(--mono);
  }
  .mhint {
    font: var(--t-footnote);
    color: var(--fg-muted);
  }
  /* Bypass permissions — приглушённо, как в VS Code. */
  .muted-mode .mname {
    color: var(--fg-muted);
  }
  .select {
    flex: none;
    max-width: 55%;
    -webkit-appearance: none;
    appearance: none;
    border: 0;
    background: none;
    color: var(--fg-muted);
    text-align: right;
    text-align-last: right;
    padding: 0;
    cursor: pointer;
  }
  .updown {
    transform: rotate(90deg);
  }
  .msg {
    flex-direction: column;
    align-items: stretch;
    gap: var(--s-2);
    cursor: text;
  }
  /* Пять строк поля: 5 × 24. */
  .msg textarea {
    min-height: 120px;
  }
</style>
