<script lang="ts">
  import { app } from '../state.svelte';
  import { haptic } from '../haptics';
  import type { PendingQuestion } from '../protocol';

  let { p }: { p: PendingQuestion } = $props();

  const OTHER = '__other__';

  // Выбор по каждому вопросу: набор меток (для одиночного выбора — одна) и текст «Другое».
  // Карточка живёт, пока жив один pending (ключ p.id), поэтому начальных значений достаточно.
  const blank = <T,>(v: () => T): T[] => p.questions.map(v);
  let picked = $state<string[][]>(blank(() => []));
  let other = $state<string[]>(blank(() => ''));
  let busy = $state(false);

  function toggle(qi: number, label: string, multi: boolean) {
    const cur = picked[qi];
    if (multi) {
      picked[qi] = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
    } else {
      picked[qi] = [label];
    }
  }

  function answerFor(qi: number): string {
    const q = p.questions[qi];
    const sel = picked[qi];
    const labels = q.options.map((o) => o.label).filter((l) => sel.includes(l));
    if (sel.includes(OTHER) && other[qi].trim()) labels.push(other[qi].trim());
    return labels.join(', ');
  }

  const complete = $derived(p.questions.every((_, qi) => answerFor(qi) !== ''));

  async function submit() {
    if (!complete || busy) return;
    haptic();
    busy = true;
    const answers: Record<string, string> = {};
    p.questions.forEach((q, qi) => (answers[q.question] = answerFor(qi)));
    try {
      await app.request({ type: 'answer_question', id: p.id, answers });
    } catch (e) {
      app.toast((e as Error).message, 'error');
      busy = false;
    }
  }
</script>

<section class="ios-card card" aria-label="Вопрос от Claude">
  <span class="ios-card-kind">Вопрос</span>
  {#each p.questions as q, qi (qi)}
    {@const multi = !!q.multiSelect}
    <fieldset>
      <legend>
        {#if q.header}<span class="ios-tag">{q.header}</span>{/if}
        <span class="ios-card-title q">{q.question}</span>
        {#if multi}<span class="hint">можно выбрать несколько</span>{/if}
      </legend>
      <div class="group">
      {#each q.options as o (o.label)}
        <label class="opt" class:on={picked[qi].includes(o.label)}>
          <input
            type={multi ? 'checkbox' : 'radio'}
            name="q-{p.id}-{qi}"
            checked={picked[qi].includes(o.label)}
            onchange={() => toggle(qi, o.label, multi)}
          />
          <span class="txt">
            <span class="ol">{o.label}</span>
            {#if o.description}<span class="od">{o.description}</span>{/if}
          </span>
          <svg class="ios-icon heavy check" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8.5l4 4 8-9" /></svg>
        </label>
      {/each}
      <label class="opt" class:on={picked[qi].includes(OTHER)}>
        <input
          type={multi ? 'checkbox' : 'radio'}
          name="q-{p.id}-{qi}"
          checked={picked[qi].includes(OTHER)}
          onchange={() => toggle(qi, OTHER, multi)}
        />
        <span class="txt"><span class="ol">Другое</span></span>
        <svg class="ios-icon heavy check" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8.5l4 4 8-9" /></svg>
      </label>
      </div>
      {#if picked[qi].includes(OTHER)}
        <input class="field" type="text" placeholder="Свой ответ" bind:value={other[qi]} />
      {/if}
    </fieldset>
  {/each}
  <button class="btn btn-primary btn-block" disabled={!complete || busy || app.net !== 'ok'} onclick={submit}>
    {busy ? 'Отправляем…' : 'Ответить'}
  </button>
</section>

<style>
  /* Inset grouped iOS: варианты — ячейки одной группы, выбранная отмечена галочкой. */
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    min-width: 0;
  }
  /* legend не участвует в gap у fieldset: отступ задаём сами. */
  legend {
    padding: 0;
    margin-bottom: var(--s-2);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-1) var(--s-2);
  }
  .q {
    width: 100%;
  }
  .hint {
    font: var(--t-footnote);
    color: var(--fg-muted);
  }
  .group {
    border-radius: var(--radius-nested);
    background: var(--bg-sunken);
    overflow: hidden;
  }
  .opt {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--s-3);
    min-height: var(--cell-min-h);
    padding: var(--cell-py) var(--cell-px);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .opt + .opt::before {
    content: '';
    position: absolute;
    top: 0;
    left: var(--cell-px);
    right: 0;
    border-top: 0.5px solid var(--border-strong);
  }
  .opt:active {
    background: color-mix(in srgb, var(--fg) 6%, transparent);
  }
  /* Нативный переключатель скрыт, но остаётся в фокусе и доступен скринридеру. */
  .opt input {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
    margin: 0;
  }
  .opt:has(input:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .txt {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .ol {
    overflow-wrap: anywhere;
  }
  .on .ol {
    color: var(--accent);
    font-weight: var(--w-semibold);
  }
  .od {
    font: var(--t-subhead);
    color: var(--fg-muted);
    overflow-wrap: anywhere;
  }
  .check {
    color: var(--accent);
    visibility: hidden;
  }
  .on .check {
    visibility: visible;
  }
</style>
