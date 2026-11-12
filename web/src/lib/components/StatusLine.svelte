<script lang="ts">
  import type { Activity } from '../protocol';

  let {
    activity,
    waiting,
  }: {
    activity?: Activity;
    /** Что ждёт ответа пользователя: разрешение или вопрос. Есть — строка показывает ожидание. */
    waiting?: 'permission' | 'question';
  } = $props();

  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });

  // ✳ на iOS рисуется как эмодзи, поэтому вместо него ✽; U+FE0E просит текстовое начертание.
  const FRAMES = ['·', '✢', '✽', '✶', '✻', '✶', '✽', '✢'].map((f) => f + '\uFE0E');
  let frame = $state(0);
  $effect(() => {
    // При «уменьшить движение» звезда стоит на месте.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      frame = 4;
      return;
    }
    const t = setInterval(() => (frame = (frame + 1) % FRAMES.length), 180);
    return () => clearInterval(t);
  });

  /** «12s», «1m 5s», «1h 2m». */
  function elapsed(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }

  const text = $derived(
    waiting === 'permission'
      ? 'Ждёт разрешения'
      : waiting === 'question'
        ? 'Ждёт вашего ответа'
        : activity?.tool
          ? `Выполняет ${activity.tool}${activity.hint ? `: ${activity.hint}` : ''}`
          : activity?.writing
            ? 'Пишет ответ…'
            : 'Думает…',
  );
</script>

<div class="status" class:waiting role="status" aria-live="off">
  <span class="glyph" aria-hidden="true">{FRAMES[frame]}</span>
  <span class="text">{text}</span>
  {#if activity && !waiting}<span class="sep" aria-hidden="true">·</span><span class="time"
      >{elapsed(now - activity.since)}</span
    >{/if}
</div>

<style>
  .status {
    display: flex;
    align-items: baseline;
    gap: var(--s-1);
    min-width: 0;
    color: var(--fg-muted);
    font: var(--t-subhead);
  }
  .sep {
    flex: none;
    color: var(--fg-faint);
  }
  /* Ширина фиксирована: смена кадра звезды не двигает текст. */
  .glyph {
    flex: none;
    width: var(--icon-sm);
    text-align: center;
    color: var(--accent);
  }
  .text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .time {
    flex: none;
    color: var(--fg-faint);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
