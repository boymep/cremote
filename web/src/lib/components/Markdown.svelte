<script lang="ts">
  import { renderMarkdown } from '../markdown';
  import { openFile } from '../fileviewer.svelte';

  let { text, cwd, sessionId, baseDir }: { text: string; cwd?: string; sessionId?: string; baseDir?: string } = $props();
  // renderMarkdown пропускает HTML через DOMPurify.
  const html = $derived(renderMarkdown(text, { cwd, sessionId, baseDir }));

  /** Тап по ссылке на локальный файл открывает просмотрщик вместо новой вкладки. */
  function onclick(e: MouseEvent) {
    const a = (e.target as Element | null)?.closest('a[data-file]');
    if (!a) return;
    e.preventDefault();
    openFile(a.getAttribute('href') ?? '');
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="md" {onclick}>{@html html}</div>
