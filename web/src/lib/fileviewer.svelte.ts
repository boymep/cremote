/**
 * Состояние экрана просмотра файлов (FileViewer.svelte).
 * Экран получает свою запись истории (pushState с тем же адресом): жест «назад», кнопка Android и браузера
 * возвращают в тот же чат, а лента под экраном остаётся смонтированной и сохраняет прокрутку.
 * Адрес файла лежит в history.state, поэтому после перезагрузки экран открывается снова.
 */
const KEY = 'cremoteFile';

export const viewer = $state<{ url: string | null }>({ url: null });

function fromState(): string | null {
  const st = history.state as Record<string, unknown> | null;
  return st && typeof st[KEY] === 'string' ? (st[KEY] as string) : null;
}

if (typeof window !== 'undefined') {
  viewer.url = fromState();
  window.addEventListener('popstate', () => {
    viewer.url = fromState();
  });
}

export function openFile(url: string): void {
  if (!url) return;
  try {
    history.pushState({ ...((history.state as object | null) ?? {}), [KEY]: url }, '');
  } catch {
    /* без истории экран всё равно откроется, закрыть его можно кнопкой */
  }
  viewer.url = url;
}

export function closeFile(): void {
  if (fromState()) history.back();
  else viewer.url = null;
}

/** Параметры из адреса `/api/file?…`: сессия нужна для выдачи доступа к HTML-предпросмотру. */
export function sessionOf(url: string): string {
  try {
    return new URL(url, location.href).searchParams.get('session') ?? '';
  } catch {
    return '';
  }
}
