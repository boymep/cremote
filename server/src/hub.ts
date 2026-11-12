import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { UPLOADS_DIR, type QueuedMessage, type State } from './config.js';
import { PendingRegistry } from './pending.js';
import { TranscriptStore } from './transcripts.js';
import { PHONE_PREFIX } from './normalize.js';
import type { SdkManager } from './sdk.js';
import type { AccountsMonitor } from './accounts.js';
import type { ProcessTracker } from './processes.js';
import { UserError, type Activity, type SessionInfo, type SessionStatus } from './types.js';

/** A non-SDK session touched more recently than this may still be open in VS Code. */
export const RESUME_GUARD_MS = 15 * 60 * 1000;
/** Same guard when process detection says the session is not open. */
export const RESUME_GUARD_TRUSTED_MS = 2 * 60 * 1000;
const OPEN_ERROR =
  'Вкладка открыта в VS Code, но без хуков cremote. Перезагрузите окно VS Code (Developer: Reload Window), и сообщения с телефона заработают.';
const RECENT_ERROR = 'Сессия только что менялась. Подождите 2 минуты.';
const RESUME_GUARD_ERROR = 'Сессия, возможно, ещё открыта в VS Code. Закройте её там или подождите 15 минут.';
const QUEUE_SEPARATOR = '\n\n---\n\n';
export const DEFAULT_PHONE_PRESENCE_MS = 30 * 60 * 1000;

/** Message text plus paths of attached images. */
export function withAttachments(text: string, uploads: { path: string }[]): string {
  if (!uploads.length) return text;
  return `${text}\n\n[Attached images — open them with the Read tool: ${uploads.map((u) => u.path).join(', ')}]`;
}

/** Persisted live entries older than this are dropped on start. */
const LIVE_RETENTION_MS = 30 * 24 * 3600 * 1000;

/** How a phone message is presented to Claude (Stop reason, PostToolUse context, rewake). */
export function phoneMessage(text: string): string {
  return `${PHONE_PREFIX}\n\n${text}`;
}

export const INTERRUPT_REASON =
  'The user pressed Stop from the cremote remote. Stop working now: do not call more tools, briefly say where you stopped, and wait for the next instruction.';

/** Короткая подсказка к вызову инструмента: команда, имя файла или шаблон, не длиннее 40 символов. */
export function toolHint(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const i = input as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === 'string' && i[k] ? (i[k] as string) : undefined);
  const file = str('file_path') ?? str('notebook_path') ?? str('path');
  let h = file ? path.basename(file) : (str('command') ?? str('pattern') ?? str('query') ?? str('url') ?? str('description') ?? str('prompt'));
  if (!h) return undefined;
  h = h.replace(/\s+/g, ' ').trim();
  return h.length > 40 ? `${h.slice(0, 39)}…` : h;
}

/** Runtime state of a session reported by hooks (VS Code / CLI). */
export interface LiveSession {
  status: SessionStatus;
  cwd?: string;
  transcriptPath?: string;
  interruptRequested?: boolean;
  /**
   * Set while an async `Wait` hook (asyncRewake) of this session is connected: calling it with a
   * text wakes the idle session with that message; with null tells the hook to exit quietly.
   */
  waker?: (text: string | null) => void;
  updatedAt: number;
}

export interface Upload {
  id: string;
  path: string;
  mediaType: string;
}

/**
 * Shared server state: session index, hook-reported statuses, pending requests, phone presence, queues.
 * Events: 'sessions' (debounced), 'pending', 'notify', 'presence'.
 */
export class Hub extends EventEmitter {
  readonly live = new Map<string, LiveSession>();
  readonly pending = new PendingRegistry();
  /** Pending ids created by hooks (as opposed to SDK canUseTool). */
  readonly hookPending = new Set<string>();
  /** One-shot phone approvals of calls blocked by the classifier (see hooks.ts PermissionDenied). */
  private approvals: { sessionId: string; key: string; expires: number }[] = [];

  addApproval(sessionId: string, toolName: string, input: unknown, ttlMs = 10 * 60_000): void {
    this.pruneApprovals();
    this.approvals.push({ sessionId, key: approvalKey(toolName, input), expires: Date.now() + ttlMs });
  }

  /** Consumes a matching approval (exact session, tool and input). */
  takeApproval(sessionId: string, toolName: string, input: unknown): boolean {
    this.pruneApprovals();
    const key = approvalKey(toolName, input);
    const i = this.approvals.findIndex((a) => a.sessionId === sessionId && a.key === key);
    if (i < 0) return false;
    this.approvals.splice(i, 1);
    return true;
  }

  private pruneApprovals(): void {
    const now = Date.now();
    this.approvals = this.approvals.filter((a) => a.expires > now);
  }
  sdk!: SdkManager;
  accounts?: AccountsMonitor;
  processes?: ProcessTracker;
  private clients = 0;
  /** When the last WS client disconnected (ms); 0 while a client is connected. */
  private lastClientAt = 0;
  private presenceTimer?: NodeJS.Timeout;
  phonePresenceMs = DEFAULT_PHONE_PRESENCE_MS;
  /** WS clients that reported presence {visible:true}. */
  private visibleClients = 0;
  private sessionsTimer?: NodeJS.Timeout;
  /** Что Claude делает сейчас; запись есть только пока сессия working. */
  private readonly activities = new Map<string, Activity>();
  private persistTimer?: NodeJS.Timeout;

  constructor(
    readonly transcripts: TranscriptStore,
    readonly state: State,
    private saveState: () => void,
  ) {
    super();
    this.restoreLive();
    transcripts.on('changed', () => this.sessionsChanged());
    this.pending.on('changed', () => this.emit('pending', this.pending.list()));
  }

  /** Restores hook statuses; awaiting_input (a legacy waiting Stop hook) becomes idle. */
  private restoreLive(): void {
    const now = Date.now();
    for (const [id, p] of Object.entries(this.state.live ?? {})) {
      if (now - p.updatedAt > LIVE_RETENTION_MS) continue;
      const status = p.status === 'awaiting_input' ? 'idle' : p.status;
      this.live.set(id, { status, cwd: p.cwd, updatedAt: p.updatedAt });
    }
    this.persistLive();
  }

  persistLive(): void {
    const out: State['live'] = {};
    for (const [id, l] of this.live) {
      if (l.status === 'history') continue;
      if (l.status === 'ended' && !this.transcripts.get(id)) continue;
      out[id] ={ status: l.status, ...(l.cwd ? { cwd: l.cwd } : {}), updatedAt: l.updatedAt };
    }
    this.state.live = out;
    this.saveState();
  }

  get clientCount(): number {
    return this.clients;
  }

  /** The phone is present while a WS client is connected and for phonePresenceMs after the last one left. */
  phonePresent(): boolean {
    return this.clients > 0 || (this.lastClientAt > 0 && Date.now() - this.lastClientAt < this.phonePresenceMs);
  }

  /** True while at least one phone client says its app is in the foreground (push is pointless then). */
  phoneForeground(): boolean {
    return this.visibleClients > 0;
  }

  setVisibleClients(n: number): void {
    this.visibleClients = n;
  }

  persistState(): void {
    this.saveState();
  }

  setClientCount(n: number): void {
    const was = this.clients;
    this.clients = n;
    clearTimeout(this.presenceTimer);
    this.presenceTimer = undefined;
    if (n > 0) {
      this.lastClientAt = 0;
      return;
    }
    if (was > 0) this.lastClientAt = Date.now();
    if (this.lastClientAt) {
      const left = Math.max(0, this.lastClientAt + this.phonePresenceMs - Date.now());
      this.presenceTimer = setTimeout(() => this.presenceExpired(), left);
      this.presenceTimer.unref();
    }
  }

  /** Nobody is holding the phone any more: let waiting permission cards fall through to VS Code. */
  private presenceExpired(): void {
    if (this.phonePresent()) return;
    this.emit('presence', false);
    this.releaseHookPending(() => true);
  }

  /** Takes and clears the queue of a session; returns the text for Claude or null. */
  takeQueued(sessionId: string): string | null {
    const q = this.state.queues[sessionId];
    if (!q?.length) return null;
    delete this.state.queues[sessionId];
    this.saveState();
    this.sessionsChanged();
    const parts = q.map((m) => {
      let uploads: { path: string }[] = [];
      try {
        uploads = this.resolveUploads(m.attachments);
      } catch {
        /* an upload vanished; send the text anyway */
      }
      return withAttachments(m.text, uploads);
    });
    return phoneMessage(parts.join(QUEUE_SEPARATOR));
  }

  /**
   * Wakes an idle hook session through its Wait hook if it has queued messages.
   * A working session gets them at the next PostToolUse or Stop instead.
   */
  wakeIfIdle(sessionId: string): boolean {
    const live = this.live.get(sessionId);
    if (!live?.waker || live.status === 'working' || !this.state.queues[sessionId]?.length) return false;
    const text = this.takeQueued(sessionId);
    if (text === null) return false;
    const waker = live.waker;
    this.setLive(sessionId, { status: 'working', interruptRequested: false });
    waker(text);
    return true;
  }

  cancelQueued(sessionId: string, id: string): void {
    const q = this.state.queues[sessionId] ?? [];
    const i = q.findIndex((m) => m.id === id);
    if (i < 0) throw new UserError('Сообщение уже отправлено');
    q.splice(i, 1);
    if (!q.length) delete this.state.queues[sessionId];
    this.saveState();
    this.sessionsChanged();
  }

  /** Lets hook-originated pending requests fall through to the local Claude Code UI. */
  releaseHookPending(pred: (p: ReturnType<PendingRegistry['list']>[number]) => boolean): void {
    this.pending.cancelWhere((p) => this.hookPending.has(p.id) && pred(p));
  }

  /** Debounced 'sessions' broadcast (500 ms). */
  sessionsChanged(): void {
    if (this.sessionsTimer) return;
    this.sessionsTimer = setTimeout(() => {
      this.sessionsTimer = undefined;
      this.emit('sessions', this.sessions());
    }, 500);
  }

  /**
   * Обновляет активность хода. null — ход закончился. Без patch.since начинает ход, если его не было.
   * Рассылка только при реальном изменении.
   */
  setActivity(id: string, patch: Partial<Activity> | null, restart = false): void {
    if (patch === null) {
      if (this.activities.delete(id)) this.sessionsChanged();
      return;
    }
    const cur = restart ? undefined : this.activities.get(id);
    const next: Activity = { since: cur?.since ?? Date.now() };
    const merged = { ...cur, ...patch, since: next.since };
    for (const k of ['tool', 'hint', 'writing'] as const) if (merged[k] !== undefined) (next as any)[k] = merged[k];
    if (cur && cur.tool === next.tool && cur.hint === next.hint && cur.writing === next.writing) return;
    this.activities.set(id, next);
    this.sessionsChanged();
  }

  setLive(id: string, patch: Partial<LiveSession>): LiveSession {
    const cur = this.live.get(id) ?? { status: 'live' as SessionStatus, updatedAt: Date.now() };
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    this.live.set(id, next);
    if (next.status === 'working' && cur.status !== 'working') {
      this.emit('working', id);
      this.setActivity(id, {}, true);
    } else if (next.status !== 'working') this.setActivity(id, null);
    this.sessionsChanged();
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = undefined;
        this.persistLive();
      }, 1000);
    }
    return next;
  }

  sessions(): SessionInfo[] {
    const out = new Map<string, SessionInfo>();
    for (const t of this.transcripts.list()) {
      out.set(t.id, {
        id: t.id,
        cwd: t.cwd,
        project: path.basename(t.cwd || ''),
        title: t.title,
        mtime: t.mtime,
        status: 'history',
        source: t.source,
        open: false,
      });
    }
    // Hooks also fire for sessions that never get a transcript (a tab opened and closed
    // without messages), so hook and process data only annotate sessions with a .jsonl.
    for (const [id, l] of this.live) {
      const info = out.get(id);
      if (info) info.status = l.status;
    }
    for (const [id, q] of Object.entries(this.state.queues)) {
      const info = out.get(id);
      if (info && q.length) info.queued = q.map((m) => ({ ...m, attachments: [...m.attachments] }));
    }
    for (const s of this.sdk?.list() ?? []) {
      const info = out.get(s.id) ?? {
        id: s.id,
        cwd: s.cwd,
        project: path.basename(s.cwd),
        title: '',
        mtime: Date.now(),
        status: 'history' as SessionStatus,
        source: 'sdk' as const,
        open: false,
      };
      info.status = s.status;
      info.source = 'sdk';
      info.permissionMode = s.permissionMode;
      info.open = true;
      out.set(s.id, info);
    }
    for (const [id, o] of this.processes?.openSessions() ?? []) {
      const info = out.get(id);
      if (!info) continue;
      info.open = true;
      info.openSince = o.since;
      if (o.via === 'guess') info.openGuess = true;
      out.set(id, info);
    }
    for (const [id, a] of this.activities) {
      const info = out.get(id);
      if (info?.status === 'working') info.activity = { ...a };
    }
    return [...out.values()].sort((a, b) => b.mtime - a.mtime);
  }

  /** Unique cwds, freshest first. */
  projects(): string[] {
    const seen = new Set<string>();
    for (const s of this.sessions()) if (s.cwd) seen.add(s.cwd);
    return [...seen];
  }

  resolveUploads(ids: unknown): Upload[] {
    if (!Array.isArray(ids)) return [];
    return ids.map((id) => {
      if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new UserError('Некорректный id вложения');
      const name = fs.readdirSync(UPLOADS_DIR).find((f) => f.startsWith(`${id}.`));
      if (!name) throw new UserError('Вложение не найдено, загрузите его заново');
      const ext = name.slice(id.length + 1);
      return { id, path: path.join(UPLOADS_DIR, name), mediaType: extToMedia(ext) };
    });
  }

  async sendMessage(sessionId: string, text: string, attachmentIds: unknown): Promise<{ queued?: boolean }> {
    const uploads = this.resolveUploads(attachmentIds);
    if (!text.trim() && !uploads.length) throw new UserError('Пустое сообщение');
    if (this.sdk.has(sessionId)) {
      this.sdk.send(sessionId, text, uploads);
      return {};
    }
    const live = this.live.get(sessionId);
    const status = live?.status ?? 'history';
    if (status === 'working' || status === 'live' || status === 'idle' || status === 'awaiting_input') {
      // Idle with a Wait hook: woken right away. Working: next PostToolUse (mid-turn) or Stop.
      // Idle without a Wait hook (installed before it existed): after the next local prompt.
      const msg: QueuedMessage = { id: crypto.randomUUID(), text, attachments: uploads.map((u) => u.id), createdAt: Date.now() };
      (this.state.queues[sessionId] ??= []).push(msg);
      this.saveState();
      this.sessionsChanged();
      return this.wakeIfIdle(sessionId) ? {} : { queued: true };
    }
    const meta = this.transcripts.get(sessionId);
    if (!meta) throw new UserError('Сессия не найдена');
    if (this.processes) {
      await this.processes.scan(true);
      if (this.processes.info(sessionId)) throw new UserError(OPEN_ERROR);
    }
    const cur = this.live.get(sessionId);
    if (meta.source !== 'sdk' && cur?.status !== 'ended') {
      // With process detection, "not open" is reliable unless an unattributed process runs in the same cwd.
      const trusted = this.processes?.scannedOnce && !this.processes.uncertain(meta.cwd);
      const windowMs = trusted ? RESUME_GUARD_TRUSTED_MS : RESUME_GUARD_MS;
      const now = Date.now();
      const recent = now - meta.mtime < windowMs || (cur ? now - cur.updatedAt < windowMs : false);
      if (recent) throw new UserError(trusted ? RECENT_ERROR : RESUME_GUARD_ERROR);
    }
    await this.sdk.resume(sessionId, meta.cwd, text, uploads);
    return {};
  }

  async interrupt(sessionId: string): Promise<void> {
    if (this.sdk.has(sessionId)) {
      await this.sdk.interrupt(sessionId);
      return;
    }
    const live = this.live.get(sessionId);
    if (!live) throw new UserError('Сессия не активна');
    if (live.status === 'idle') return;
    this.setLive(sessionId, { interruptRequested: true });
    // A tool call waiting for approval is the next thing Claude does: deny it right away.
    for (const p of this.pending.list()) {
      if (p.sessionId !== sessionId || !this.hookPending.has(p.id)) continue;
      if (p.kind === 'permission') this.pending.answerPermission(p.id, { behavior: 'deny', message: INTERRUPT_REASON });
      else this.pending.cancel(p.id);
    }
  }
}

export function extToMedia(ext: string): string {
  const map: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic' };
  return map[ext.toLowerCase()] ?? 'application/octet-stream';
}

export function mediaToExt(media: string): string | null {
  const map: Record<string, string> = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic' };
  return map[media.toLowerCase()] ?? null;
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function approvalKey(toolName: string, input: unknown): string {
  return `${toolName}\0${stableStringify(input ?? {})}`;
}
