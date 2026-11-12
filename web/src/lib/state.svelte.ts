import type {
  Accounts,
  UpdateInfo,
  ClientMessageBody,
  Message,
  Pending,
  ServerMessage,
  SessionInfo,
} from './protocol';
import { realApi, realSocketFactory, WS_OPEN, type Api, type SocketFactory, type SocketLike } from './socket';
import { alertNewPending } from './notify';
import { flushSync } from 'svelte';

export type OkReply = Extract<ServerMessage, { type: 'ok' }>;

export type AuthState = 'checking' | 'login' | 'ok';
export type ConnState = 'connecting' | 'open' | 'closed';
/**
 * Состояние связи для интерфейса:
 * ok — hello получен; connecting — первое подключение; reconnecting — связь была и пропала;
 * offline — у устройства нет сети; down — сервер или туннель не отвечают (сеть/5xx).
 */
export type NetState = 'ok' | 'connecting' | 'reconnecting' | 'offline' | 'down';

export type Route =
  | { name: 'list' }
  | { name: 'session'; id: string }
  | { name: 'new' }
  | { name: 'settings' };

export interface SessionFeed {
  messages: Message[];
  hasMore: boolean;
  loaded: boolean;
  loadingMore: boolean;
  /** Последнее изменение ленты: нужно для автопрокрутки и сохранения позиции. */
  lastMode: 'replace' | 'append' | 'prepend' | null;
  version: number;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
  sessionId?: string;
}

function parseRoute(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('s/')) return { name: 'session', id: decodeURIComponent(h.slice(2)) };
  if (h === 'new') return { name: 'new' };
  if (h === 'settings') return { name: 'settings' };
  return { name: 'list' };
}

export function routeHref(r: Route): string {
  if (r.name === 'session') return `#/s/${encodeURIComponent(r.id)}`;
  if (r.name === 'new') return '#/new';
  if (r.name === 'settings') return '#/settings';
  return '#/';
}

/** Направление перехода: push — вглубь (список → сессия), pop — назад. */
export type NavDir = 'push' | 'pop' | 'none';

const routeDepth = (r: Route) => (r.name === 'list' ? 0 : 1);

function navDirection(from: Route, to: Route): NavDir {
  const d = routeDepth(to) - routeDepth(from);
  if (d > 0) return 'push';
  if (d < 0) return 'pop';
  // Сессия → другая сессия (например, по тосту) — тоже вглубь.
  return routeHref(from) === routeHref(to) ? 'none' : 'push';
}

let navSeq = 0;

/**
 * Смена экрана через View Transitions API (iOS 18+): в html ставится data-nav=push|pop,
 * анимации описаны в app.css. Без API или при «уменьшении движения» — просто смена.
 */
function runNavTransition(dir: NavDir, update: () => void) {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (dir === 'none' || reduce || typeof document.startViewTransition !== 'function') {
    update();
    return;
  }
  const root = document.documentElement;
  const seq = ++navSeq;
  root.dataset.nav = dir;
  try {
    const t = document.startViewTransition(() => flushSync(update));
    void t.finished.finally(() => {
      if (seq === navSeq) delete root.dataset.nav;
    });
  } catch {
    delete root.dataset.nav;
    update();
  }
}

/** Отметка в history.state: адрес экрана, с которого пришли на эту запись истории. */
interface NavEntryState {
  cremoteFrom: string | null;
}

function entryFrom(): string | null {
  const st = history.state as Partial<NavEntryState> | null;
  return st && typeof st.cremoteFrom === 'string' ? st.cremoteFrom : null;
}

/** Мок-режим: `VITE_MOCK=1` или `?mock` в dev. В обычной сборке код мока вырезается. */
const MOCK =
  import.meta.env.VITE_MOCK === '1' ||
  (import.meta.env.DEV && new URLSearchParams(location.search).has('mock'));

const BACKOFF = [500, 1000, 2000, 4000, 8000, 15000];

class AppState {
  auth = $state<AuthState>('checking');
  conn = $state<ConnState>('closed');
  /** Получен ли hello после последнего подключения. */
  synced = $state(false);
  /** hello приходил хотя бы раз за жизнь вкладки. */
  everSynced = $state(false);
  online = $state(typeof navigator === 'undefined' ? true : navigator.onLine);
  /** /api/me ответил 5xx или не ответил: туннель или сервер лежат. */
  serverDown = $state(false);
  /** Когда будет следующая попытка подключения (мс), если она запланирована. */
  retryAt = $state<number | null>(null);
  remoteAccess = $state(false);
  sessions = $state<SessionInfo[]>([]);
  pending = $state<Pending[]>([]);
  accounts = $state<Accounts | null>(null);
  /** Номер аккаунта, на который идёт переключение (до ~2 мин). */
  switchingAccount = $state<number | null>(null);
  refreshingAccounts = $state(false);
  /** Версия сервера и доступное обновление; null, пока сервер не прислал. */
  update = $state<UpdateInfo | null>(null);
  /** Версия, до которой идёт обновление; null — не обновляемся. */
  updatingTo = $state<string | null>(null);
  /** Когда последнее переключение аккаунта завершилось успешно (для подсказки про VS Code). */
  lastSwitchAt = $state<number | null>(null);
  feeds = $state<Record<string, SessionFeed>>({});
  route = $state<Route>(parseRoute());
  toasts = $state<Toast[]>([]);
  now = $state(Date.now());
  /** Сессия, которую ждём после create_session. */
  creating = $state<{ cwd: string; knownIds: string[]; startedAt: number } | null>(null);

  readonly mock = MOCK;
  api: Api = realApi;
  private socketFactory: SocketFactory = realSocketFactory;
  private ws: SocketLike | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reqSeq = 0;
  private waiters = new Map<
    string,
    { resolve: (r: OkReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private subscribed: string | null = null;
  private seenPending = new Set<string>();
  private toastSeq = 0;
  private started = false;

  get net(): NetState {
    if (this.conn === 'open' && this.synced) return 'ok';
    if (!this.online) return 'offline';
    if (this.serverDown) return 'down';
    return this.everSynced ? 'reconnecting' : 'connecting';
  }

  sessionById(id: string): SessionInfo | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  pendingFor(sessionId: string): Pending[] {
    return this.pending.filter((p) => p.sessionId === sessionId);
  }

  // ---------- Запуск ----------

  async start() {
    if (this.started) return;
    this.started = true;
    // Первая запись истории ни откуда не пришла: «назад» с неё подменяет адрес, а не уходит из приложения.
    if (history.state == null) history.replaceState({ cremoteFrom: null } satisfies NavEntryState, '');
    window.addEventListener('hashchange', () => this.onRouteChange());
    setInterval(() => (this.now = Date.now()), 30_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.conn === 'closed') this.reconnectNow();
      this.sendPresence();
    });
    window.addEventListener('online', () => {
      this.online = true;
      if (this.conn === 'closed') this.reconnectNow();
    });
    window.addEventListener('offline', () => (this.online = false));

    if (MOCK) {
      const m = await import('./mock');
      this.socketFactory = m.mockSocketFactory;
      this.api = m.mockApi;
      if (m.mockConn === 'offline') this.online = false;
    }
    await this.checkAuth();
  }

  /** Первичная проверка cookie. Пока сервер недоступен, повторяем с backoff. */
  private async checkAuth() {
    const status = await this.api.me();
    if (status === 401) {
      this.serverDown = false;
      this.auth = 'login';
      return;
    }
    if (status === 0 || status >= 500) {
      this.serverDown = true;
      this.scheduleRetry(() => void this.checkAuth());
      return;
    }
    this.serverDown = false;
    this.auth = 'ok';
    this.connect();
  }

  async login(password: string): Promise<string | null> {
    let status: number;
    try {
      status = await this.api.login(password);
    } catch {
      status = 0;
    }
    if (status === 0 || status >= 500) {
      this.serverDown = true;
      return this.online ? 'Сервер недоступен. Проверьте, что Mac и туннель работают.' : 'Нет сети';
    }
    this.serverDown = false;
    if (status >= 200 && status < 300) {
      this.auth = 'ok';
      this.attempt = 0;
      this.connect();
      return null;
    }
    if (status === 429) return 'Слишком много попыток. Подождите 15 минут.';
    if (status === 401 || status === 403) return 'Неверный пароль';
    return `Ошибка входа (HTTP ${status})`;
  }

  async logout() {
    try {
      await this.api.logout();
    } catch {
      /* всё равно выходим */
    }
    this.disconnect();
    this.auth = 'login';
    this.sessions = [];
    this.pending = [];
    this.accounts = null;
    this.feeds = {};
  }

  // ---------- Соединение ----------

  private connect() {
    if (this.ws || this.auth !== 'ok') return;
    this.conn = 'connecting';
    this.synced = false;
    let ws: SocketLike;
    try {
      ws = this.socketFactory();
    } catch {
      this.conn = 'closed';
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    // Через nginx и туннель апгрейд может зависнуть: не ждём дольше 12 с.
    const openTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState !== WS_OPEN) ws.close();
    }, 12_000);
    ws.onopen = () => {
      clearTimeout(openTimer);
      this.conn = 'open';
      this.sendPresence();
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onerror = () => {
      /* onclose придёт следом */
    };
    ws.onclose = () => {
      clearTimeout(openTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      this.conn = 'closed';
      this.synced = false;
      this.subscribed = null;
      for (const [, w] of this.waiters) {
        clearTimeout(w.timer);
        w.reject(new Error('Связь потеряна'));
      }
      this.waiters.clear();
      for (const f of Object.values(this.feeds)) f.loadingMore = false;
      void this.afterClose();
    };
  }

  private async afterClose() {
    if (this.auth !== 'ok') return;
    // Сервер мог отклонить апгрейд из-за истёкшей cookie, или лежит туннель (502 от nginx).
    const status = await this.api.me();
    if (this.auth !== 'ok') return;
    if (status === 401) {
      this.auth = 'login';
      return;
    }
    this.serverDown = status === 0 || status >= 500;
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    this.scheduleRetry(() => this.connect());
  }

  private scheduleRetry(fn: () => void) {
    if (this.reconnectTimer) return;
    const base = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
    const delay = base + Math.random() * base * 0.3;
    this.attempt++;
    this.retryAt = Date.now() + delay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.retryAt = null;
      fn();
    }, delay);
  }

  /** Повторить сразу: кнопка «Повторить», возврат во вкладку, появление сети. */
  reconnectNow() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.retryAt = null;
    this.attempt = 0;
    if (this.auth === 'checking') void this.checkAuth();
    else if (this.auth === 'ok') this.connect();
  }

  private disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.retryAt = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.conn = 'closed';
  }

  /** Отправить сообщение. Промис ждёт ok (его поля отдаются) или error с тем же requestId. */
  request(body: ClientMessageBody, timeoutMs = 20_000): Promise<OkReply> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return Promise.reject(new Error('Нет связи с сервером'));
    const requestId = `r${++this.reqSeq}`;
    return new Promise<OkReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        reject(new Error('Сервер не ответил'));
      }, timeoutMs);
      this.waiters.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...body, requestId }));
    });
  }

  /** Сообщает серверу, на переднем ли плане приложение: пока да, push не шлём. */
  private sendPresence() {
    this.send({ type: 'presence', visible: document.visibilityState === 'visible' });
  }

  /** Отправить без ожидания ответа. */
  send(body: ClientMessageBody) {
    const ws = this.ws;
    if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify(body));
  }

  // ---------- Входящие ----------

  private handle(msg: ServerMessage) {
    switch (msg.type) {
      case 'hello':
        this.remoteAccess = msg.remoteAccess ?? false;
        this.sessions = msg.sessions;
        this.setPending(msg.pending, true);
        if ('accounts' in msg) this.accounts = msg.accounts ?? null;
        this.synced = true;
        this.everSynced = true;
        this.serverDown = false;
        this.attempt = 0;
        this.syncSubscription();
        break;
      case 'sessions':
        this.sessions = msg.sessions;
        this.checkCreated();
        break;
      case 'accounts':
        this.accounts = msg.accounts;
        break;
      case 'update': {
        const { type: _t, ...info } = msg;
        this.update = info;
        if (this.updatingTo && !info.available) {
          this.toast(`Обновлено до ${info.current}`, 'info');
          this.updatingTo = null;
        }
        break;
      }
      case 'remote':
        this.remoteAccess = msg.enabled;
        break;
      case 'pending':
        this.setPending(msg.pending, false);
        break;
      case 'messages':
        this.applyMessages(msg);
        break;
      case 'notify': {
        const text = [msg.title, msg.message].filter(Boolean).join(': ');
        if (text) this.toast(text, 'info', msg.sessionId);
        break;
      }
      case 'ok': {
        const w = this.waiters.get(msg.requestId);
        if (w) {
          clearTimeout(w.timer);
          this.waiters.delete(msg.requestId);
          w.resolve(msg);
        }
        break;
      }
      case 'error': {
        const w = msg.requestId ? this.waiters.get(msg.requestId) : undefined;
        if (w && msg.requestId) {
          clearTimeout(w.timer);
          this.waiters.delete(msg.requestId);
          w.reject(new Error(msg.message));
        } else {
          this.toast(msg.message, 'error');
        }
        break;
      }
    }
  }

  private setPending(list: Pending[], initial: boolean) {
    const fresh = list.filter((p) => !this.seenPending.has(p.id));
    for (const p of list) this.seenPending.add(p.id);
    this.pending = list;
    if (!initial && fresh.length > 0) alertNewPending();
  }

  private applyMessages(msg: Extract<ServerMessage, { type: 'messages' }>) {
    const prev = this.feeds[msg.sessionId];
    let messages: Message[];
    if (msg.mode === 'replace' || !prev) {
      messages = msg.messages;
    } else if (msg.mode === 'append') {
      const seen = new Set(prev.messages.map((m) => m.uuid));
      messages = prev.messages.concat(msg.messages.filter((m) => !seen.has(m.uuid)));
    } else {
      const seen = new Set(prev.messages.map((m) => m.uuid));
      messages = msg.messages.filter((m) => !seen.has(m.uuid)).concat(prev.messages);
    }
    this.feeds[msg.sessionId] = {
      messages,
      hasMore: msg.mode === 'append' && prev ? prev.hasMore : msg.hasMore,
      loaded: true,
      loadingMore: false,
      lastMode: msg.mode,
      version: (prev?.version ?? 0) + 1,
    };
  }

  // ---------- Маршруты и подписка ----------

  /** Следующая смена маршрута без анимации (свайп назад уже довёл экран сам). */
  private skipTransition = false;
  private skipTimer: ReturnType<typeof setTimeout> | null = null;
  /** Откуда пришла запись, которую подменяет location.replace (undefined — обычный переход). */
  private replaceFrom: string | null | undefined = undefined;

  /** replace: подменить текущую запись истории, а не добавлять новую. */
  navigate(r: Route, opts: { replace?: boolean } = {}) {
    const href = routeHref(r);
    if (location.hash === href) {
      this.onRouteChange();
    } else if (opts.replace) {
      this.replaceFrom = entryFrom();
      location.replace(href);
    } else {
      location.hash = href;
    }
  }

  /**
   * «Назад» как в нативном приложении: если пришли со списка — history.back(),
   * иначе (открыли по ссылке) подменяем текущую запись списком, история не растёт.
   * animate: false — экран уже уведён жестом, второй анимации не нужно.
   */
  back(opts: { animate?: boolean } = {}) {
    if (this.route.name === 'list') return;
    if (opts.animate === false) {
      this.skipTransition = true;
      // Если hashchange почему-то не придёт, флаг не должен съесть анимацию следующего перехода.
      if (this.skipTimer) clearTimeout(this.skipTimer);
      this.skipTimer = setTimeout(() => (this.skipTransition = false), 1000);
    }
    const list = routeHref({ name: 'list' });
    if (entryFrom() === list) {
      history.back();
    } else {
      this.replaceFrom = null;
      location.replace(list);
    }
  }

  private onRouteChange() {
    const prev = this.route;
    const next = parseRoute();
    // Новая запись истории (переход по ссылке или replace): запоминаем, откуда пришли.
    if (history.state == null) {
      const from = this.replaceFrom !== undefined ? this.replaceFrom : routeHref(prev);
      history.replaceState({ cremoteFrom: from } satisfies NavEntryState, '');
    }
    this.replaceFrom = undefined;
    const skip = this.skipTransition;
    this.skipTransition = false;
    runNavTransition(skip ? 'none' : navDirection(prev, next), () => {
      this.route = next;
      this.syncSubscription();
    });
  }

  private syncSubscription() {
    if (!this.synced) return;
    const want = this.route.name === 'session' ? this.route.id : null;
    if (this.subscribed === want) return;
    if (this.subscribed) this.send({ type: 'unsubscribe', sessionId: this.subscribed });
    this.subscribed = want;
    if (want) this.send({ type: 'subscribe', sessionId: want });
  }

  loadMore(sessionId: string) {
    const feed = this.feeds[sessionId];
    if (!feed || !feed.hasMore || feed.loadingMore || feed.messages.length === 0) return;
    feed.loadingMore = true;
    this.request({ type: 'load_more', sessionId, before: feed.messages[0].uuid }).catch((e: Error) => {
      feed.loadingMore = false;
      this.toast(e.message, 'error');
    });
  }

  // ---------- Аккаунты ----------

  async switchAccount(number: number) {
    if (this.switchingAccount !== null) return;
    this.switchingAccount = number;
    try {
      // cswap switch может идти до 120 с, плюс обновление списка.
      await this.request({ type: 'switch_account', number }, 150_000);
      this.lastSwitchAt = Date.now();
      this.toast('Аккаунт переключён. VS Code подхватит аккаунт примерно за 30 секунд.');
    } catch (e) {
      this.toast((e as Error).message, 'error');
    } finally {
      this.switchingAccount = null;
    }
  }

  async refreshAccounts() {
    if (this.refreshingAccounts) return;
    this.refreshingAccounts = true;
    try {
      await this.request({ type: 'refresh_accounts' }, 60_000);
    } catch (e) {
      this.toast((e as Error).message, 'error');
    } finally {
      this.refreshingAccounts = false;
    }
  }

  async runUpdate() {
    const to = this.update?.latest;
    if (!to || this.updatingTo) return;
    this.updatingTo = to;
    try {
      await this.request({ type: 'run_update' });
    } catch (e) {
      this.updatingTo = null;
      this.toast((e as Error).message, 'error');
      return;
    }
    // Сервер должен вернуться уже новой версией; если нет — снимаем «Обновляю…» через 3 минуты.
    setTimeout(() => {
      if (this.updatingTo === to) {
        this.updatingTo = null;
        this.toast('Обновление не завершилось, смотрите ~/.cremote/logs/update.log', 'error');
      }
    }, 180_000);
  }

  // ---------- Создание сессии ----------

  beginCreate(cwd: string) {
    this.creating = { cwd, knownIds: this.sessions.map((s) => s.id), startedAt: Date.now() };
  }

  cancelCreate() {
    this.creating = null;
  }

  private checkCreated() {
    const c = this.creating;
    if (!c) return;
    const found = this.sessions.find(
      (s) => !c.knownIds.includes(s.id) && (s.cwd === c.cwd || s.source === 'sdk'),
    );
    if (found) {
      this.creating = null;
      // Экран «Новая сессия» подменяется сессией: «назад» из неё ведёт к списку.
      this.navigate({ name: 'session', id: found.id }, { replace: true });
    }
  }

  // ---------- Уведомления ----------

  toast(text: string, tone: Toast['tone'] = 'info', sessionId?: string) {
    const id = ++this.toastSeq;
    this.toasts = [...this.toasts.slice(-2), { id, text, tone, sessionId }];
    setTimeout(() => this.dismissToast(id), tone === 'error' ? 6000 : 4500);
  }

  dismissToast(id: number) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }
}

export const app = new AppState();
