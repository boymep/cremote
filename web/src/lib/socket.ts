import type { ModelOption } from './protocol';
// Минимальный интерфейс сокета: настоящий WebSocket и мок из mock.ts.
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = () => SocketLike;

export const WS_OPEN = 1;

export function realSocketFactory(): SocketLike {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${proto}//${location.host}/ws`);
}

/** HTTP-слой, который мок может подменить. */
export interface Api {
  me(): Promise<number>;
  login(password: string): Promise<number>;
  logout(): Promise<void>;
  projects(): Promise<string[]>;
  models(): Promise<ModelOption[]>;
  upload(file: File): Promise<{ id: string; path: string; mediaType: string }>;
}

export const realApi: Api = {
  async me() {
    try {
      const r = await fetch('/api/me', { credentials: 'same-origin', signal: AbortSignal.timeout(10_000) });
      return r.status;
    } catch {
      return 0;
    }
  },
  async login(password) {
    const r = await fetch('/api/login', {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    return r.status;
  },
  async logout() {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  },
  async projects() {
    const r = await fetch('/api/projects', { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data: unknown = await r.json();
    const list = Array.isArray(data)
      ? data
      : data && typeof data === 'object' && Array.isArray((data as { projects?: unknown }).projects)
        ? (data as { projects: unknown[] }).projects
        : [];
    return list
      .map((p) =>
        typeof p === 'string' ? p : p && typeof p === 'object' ? String((p as { cwd?: unknown }).cwd ?? '') : '',
      )
      .filter(Boolean);
  },
  async models() {
    const r = await fetch('/api/models', { credentials: 'same-origin', signal: AbortSignal.timeout(45_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data: unknown = await r.json();
    return (Array.isArray(data) ? data : [])
      .filter((m): m is ModelOption => !!m && typeof (m as ModelOption).value === 'string' && !!(m as ModelOption).value)
      .map((m) => ({ value: m.value, displayName: m.displayName || m.value, description: m.description || '' }));
  },
  async upload(file) {
    const r = await fetch('/api/upload', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
      body: file,
    });
    if (r.status === 413) throw new Error('Файл больше 10 МБ');
    if (!r.ok) throw new Error(`Загрузка не удалась (HTTP ${r.status})`);
    return r.json();
  },
};
