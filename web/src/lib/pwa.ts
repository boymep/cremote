// PWA: service worker, установка на экран «Домой», Web Push и бейдж.

type PushStateName = 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on';

export function isIOS(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ выдаёт себя за Mac, отличаем по тач-экрану
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function setBadge(n: number): void {
  const nav = navigator as Navigator & {
    setAppBadge?: (n: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (n > 0) void nav.setAppBadge?.(n)?.catch(() => {});
    else void nav.clearAppBadge?.()?.catch(() => {});
  } catch {
    /* бейдж не критичен */
  }
}

export function registerSW(): void {
  if (import.meta.env.DEV || !('serviceWorker' in navigator)) return;
  const loadedAt = Date.now();
  let reloading = false;
  let pending: ServiceWorker | null = null;

  const apply = (): void => {
    if (!pending) return;
    pending.postMessage({ type: 'skipWaiting' });
    pending = null;
  };
  const offer = (sw: ServiceWorker): void => {
    pending = sw;
    // В первые 3 с после загрузки применяем сразу, иначе ждём, пока вкладка уйдёт в фон
    if (Date.now() - loadedAt < 3000) apply();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') apply();
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; url?: string } | null;
    if (d?.type !== 'navigate' || typeof d.url !== 'string') return;
    const u = new URL(d.url, location.origin);
    if (u.origin !== location.origin) return;
    if (u.pathname === location.pathname && u.hash) location.hash = u.hash;
    else location.assign(u.href);
  });

  navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then((reg) => {
      // первая установка: controller ещё нет, перезагрузка не нужна
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) offer(nw);
        });
      });
      // iOS редко проверяет обновления сам
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void reg.update().catch(() => {});
      });
    })
    .catch(() => {});
}

async function getReg(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.ready;
}

export async function pushState(): Promise<PushStateName> {
  if (isIOS() && !isStandalone()) return 'needs-install';
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const sub = await (await getReg()).pushManager.getSubscription();
    return sub && Notification.permission === 'granted' ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Сервер ответил ${res.status}`);
  return (await res.json()) as T;
}

function urlBase64ToUint8Array(s: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Вызывать прямо из обработчика клика: iOS требует жест пользователя для запроса разрешения.
// requestPermission стартует синхронно, до любого await.
export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error('Push не поддерживается в этом браузере');
  const permissionPromise = Notification.requestPermission();
  const permission = await permissionPromise;
  if (permission !== 'granted') throw new Error('Разрешение на уведомления не выдано');
  const reg = await getReg();
  const { publicKey } = await api<{ publicKey: string }>('/api/push/key');
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
  await api('/api/push/subscribe', { subscription: sub.toJSON() });
}

export async function disablePush(): Promise<void> {
  const sub = await (await getReg()).pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await api('/api/push/unsubscribe', { endpoint });
}

export async function sendTestPush(): Promise<void> {
  await api('/api/push/test', {});
}
