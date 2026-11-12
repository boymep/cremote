/** Состояние встроенного просмотрщика файлов (FileViewer.svelte). */
export const viewer = $state<{ url: string | null }>({ url: null });

export function openFile(url: string): void {
  viewer.url = url;
}

export function closeFile(): void {
  viewer.url = null;
}
