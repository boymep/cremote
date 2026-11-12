import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { Auth } from './auth.js';
import type { Hub } from './hub.js';
import { spawnDetachedUpdate, type UpdateInfo } from './update.js';
import { UserError, type Message } from './types.js';

const PING_MS = 30_000;

/** WebSocket requires the Origin host to equal the Host header (blocks cross-site WS). */
function originMatches(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

class Client {
  private subs = new Map<string, () => void>();
  alive = true;
  /** Set by the client's { type: 'presence', visible } message. */
  visible = false;

  constructor(
    private ws: WebSocket,
    private hub: Hub,
    private onPresence: () => void = () => {},
    private updates?: { info(): UpdateInfo },
  ) {}

  send(msg: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    for (const unsub of this.subs.values()) unsub();
    this.subs.clear();
  }

  async handle(raw: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send({ type: 'error', message: 'Некорректный JSON' });
    }
    const requestId = msg?.requestId;
    try {
      const extra = await this.dispatch(msg);
      if (requestId !== undefined) this.send({ type: 'ok', requestId, ...(extra ?? {}) });
    } catch (e) {
      const message = e instanceof UserError ? e.message : e instanceof Error ? e.message : 'Внутренняя ошибка';
      if (!(e instanceof UserError)) console.error('[ws]', e);
      this.send({ type: 'error', ...(requestId !== undefined ? { requestId } : {}), message });
    }
  }

  private async dispatch(msg: any): Promise<Record<string, unknown> | void> {
    const hub = this.hub;
    const str = (v: unknown, name: string): string => {
      if (typeof v !== 'string' || !v) throw new UserError(`Не указано поле ${name}`);
      return v;
    };
    switch (msg?.type) {
      case 'subscribe': {
        const sessionId = str(msg.sessionId, 'sessionId');
        this.subs.get(sessionId)?.();
        this.subs.delete(sessionId);
        const sub = await hub.transcripts.subscribe(sessionId, (messages: Message[]) =>
          this.send({ type: 'messages', sessionId, messages, mode: 'append', hasMore: false }),
        );
        this.subs.set(sessionId, sub.unsubscribe);
        this.send({ type: 'messages', sessionId, messages: sub.messages, mode: 'replace', hasMore: sub.hasMore });
        return;
      }
      case 'unsubscribe': {
        const sessionId = str(msg.sessionId, 'sessionId');
        this.subs.get(sessionId)?.();
        this.subs.delete(sessionId);
        return;
      }
      case 'load_more': {
        const sessionId = str(msg.sessionId, 'sessionId');
        const res = await hub.transcripts.loadMore(sessionId, str(msg.before, 'before'));
        this.send({ type: 'messages', sessionId, messages: res.messages, mode: 'prepend', hasMore: res.hasMore });
        return;
      }
      case 'presence':
        this.visible = msg.visible === true;
        this.onPresence();
        return;
      case 'set_remote':
        // Legacy toggle: phone presence replaced it. Accepted and ignored.
        return;
      case 'answer_permission': {
        const behavior = msg.behavior === 'allow' ? 'allow' : msg.behavior === 'deny' ? 'deny' : null;
        if (!behavior) throw new UserError('behavior должен быть allow или deny');
        const ok = hub.pending.answerPermission(str(msg.id, 'id'), {
          behavior,
          ...(typeof msg.message === 'string' ? { message: msg.message } : {}),
          ...(Array.isArray(msg.updatedPermissions) ? { updatedPermissions: msg.updatedPermissions } : {}),
        });
        if (!ok) throw new UserError('Запрос уже неактуален');
        return;
      }
      case 'answer_question': {
        const answers: Record<string, string> = {};
        if (msg.answers && typeof msg.answers === 'object') {
          for (const [k, v] of Object.entries(msg.answers)) if (typeof v === 'string') answers[k] = v;
        }
        if (!hub.pending.answerQuestion(str(msg.id, 'id'), { answers })) throw new UserError('Вопрос уже неактуален');
        return;
      }
      case 'send_message': {
        const res = await hub.sendMessage(str(msg.sessionId, 'sessionId'), typeof msg.text === 'string' ? msg.text : '', msg.attachments ?? []);
        return res.queued ? { queued: true } : undefined;
      }
      case 'cancel_queued':
        hub.cancelQueued(str(msg.sessionId, 'sessionId'), str(msg.id, 'id'));
        return;
      case 'interrupt':
        await hub.interrupt(str(msg.sessionId, 'sessionId'));
        return;
      case 'create_session': {
        const sessionId = await hub.sdk.create({
          cwd: str(msg.cwd, 'cwd'),
          text: typeof msg.text === 'string' ? msg.text : '',
          uploads: hub.resolveUploads(msg.attachments ?? []),
          permissionMode: typeof msg.permissionMode === 'string' ? msg.permissionMode : 'auto',
          ...(typeof msg.model === 'string' && msg.model ? { model: msg.model } : {}),
        });
        return { sessionId };
      }
      case 'switch_account':
        if (!hub.accounts) throw new UserError('Аккаунты недоступны');
        await hub.accounts.switchTo(msg.number);
        return;
      case 'refresh_accounts': {
        if (!hub.accounts) throw new UserError('Аккаунты недоступны');
        const accounts = await hub.accounts.refreshManual();
        // A rate-limited call does not broadcast, so answer this client directly.
        this.send({ type: 'accounts', accounts });
        return;
      }
      case 'set_mode':
        await hub.sdk.setMode(str(msg.sessionId, 'sessionId'), str(msg.mode, 'mode'));
        return;
      case 'run_update': {
        const info = this.updates?.info();
        if (!info || info.autoUpdate === 'off') throw new UserError('Обновления отключены');
        if (!info.canUpdate) throw new UserError('Эта установка не обновляется из интерфейса');
        if (!info.available) throw new UserError('Новых версий нет');
        spawnDetachedUpdate();
        return;
      }
      default:
        throw new UserError(`Неизвестный тип сообщения: ${String(msg?.type)}`);
    }
  }
}

export function createWs(hub: Hub, auth: Auth, updates?: { info(): UpdateInfo }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const clients = new Map<WebSocket, Client>();
  const broadcast = (msg: unknown) => {
    for (const c of clients.values()) c.send(msg);
  };

  hub.on('sessions', (sessions) => broadcast({ type: 'sessions', sessions }));
  hub.on('pending', (pending) => broadcast({ type: 'pending', pending }));
  hub.on('notify', (n) => broadcast({ type: 'notify', ...n }));
  hub.on('accounts', (accounts) => broadcast({ type: 'accounts', accounts }));

  wss.on('connection', (ws: WebSocket) => {
    const countVisible = () => hub.setVisibleClients([...clients.values()].filter((c) => c.visible).length);
    const client = new Client(ws, hub, countVisible, updates);
    clients.set(ws, client);
    hub.setClientCount(clients.size);
    hub.accounts?.setClients(clients.size);
    hub.processes?.setClients(clients.size);
    ws.on('pong', () => (client.alive = true));
    ws.on('message', (data) => void client.handle(data.toString()));
    ws.on('close', () => {
      client.close();
      clients.delete(ws);
      countVisible();
      hub.setClientCount(clients.size);
      hub.accounts?.setClients(clients.size);
      hub.processes?.setClients(clients.size);
    });
    client.send({
      type: 'hello',
      sessions: hub.sessions(),
      pending: hub.pending.list(),
      accounts: hub.accounts?.accounts ?? null,
    });
    if (updates) client.send({ type: 'update', ...updates.info() });
  });

  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      const c = clients.get(ws);
      if (c && !c.alive) {
        ws.terminate();
        continue;
      }
      if (c) c.alive = false;
      ws.ping();
    }
  }, PING_MS);
  ping.unref();

  return {
    broadcast,
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== '/ws' || !auth.isAuthed(req) || !originMatches(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    },
    close(): void {
      clearInterval(ping);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
