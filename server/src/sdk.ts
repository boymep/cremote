import fs from 'node:fs';
import os from 'node:os';
import { query, type Query, type SDKUserMessage, type PermissionMode, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { documentLines, toolHint, type Hub, type Upload } from './hub.js';
import { UserError, type SessionStatus } from './types.js';

const MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto']);

export interface ModelOption {
  value: string;
  displayName: string;
  description: string;
}

/** Aliases Claude Code accepts, used when the SDK cannot report its model list. */
export const FALLBACK_MODELS: ModelOption[] = [
  { value: 'default', displayName: 'Default', description: 'Модель аккаунта по умолчанию' },
  { value: 'opus', displayName: 'Opus', description: 'Самая сильная модель' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Баланс скорости и качества' },
  { value: 'haiku', displayName: 'Haiku', description: 'Самая быстрая модель' },
];
const MODELS_TIMEOUT_MS = 30_000;
const MODELS_RETRY_MS = 5 * 60_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms} ms`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
const API_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Async queue feeding the streaming-input prompt of query(). */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiting?: (r: IteratorResult<SDKUserMessage>) => void;
  private closed = false;

  push(msg: SDKUserMessage): void {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w({ value: msg, done: false });
    } else this.items.push(msg);
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

interface SdkSession {
  id?: string;
  cwd: string;
  q: Query;
  queue: MessageQueue;
  status: SessionStatus;
  permissionMode: string;
  idleTimer?: NodeJS.Timeout;
}

/** An idle SDK process is closed after this long; the session can be resumed later. */
const IDLE_CLOSE_MS = 30 * 60 * 1000;

function userMessage(text: string, uploads: Upload[]): SDKUserMessage {
  const content: any[] = [];
  for (const u of uploads.filter((x) => x.mediaType.startsWith('image/'))) {
    if (!API_IMAGE_TYPES.has(u.mediaType)) throw new UserError(`Формат ${u.mediaType} не поддерживается, нужен JPEG, PNG, GIF или WebP`);
    content.push({ type: 'image', source: { type: 'base64', media_type: u.mediaType, data: fs.readFileSync(u.path).toString('base64') } });
  }
  // Документы уходят путём в тексте: Claude откроет их через Read.
  const full = (text + documentLines(uploads)).trim();
  if (full) content.push({ type: 'text', text: full });
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
}

/** Our own hooks would otherwise also fire for SDK processes; inherited entrypoint vars would mislabel the source. */
function sdkEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, CREMOTE_HOOK_DISABLE: '1' };
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDECODE;
  return env;
}

/** Sessions started or resumed through the Agent SDK. */
export class SdkManager {
  private sessions = new Map<string, SdkSession>();
  private modelsCache: ModelOption[] | null = null;
  private modelsLoading: Promise<ModelOption[]> | null = null;
  private modelsRetryAt = 0;

  constructor(private hub: Hub) {}

  list(): { id: string; cwd: string; status: SessionStatus; permissionMode: string }[] {
    return [...this.sessions.values()]
      .filter((s): s is SdkSession & { id: string } => !!s.id)
      .map((s) => ({ id: s.id, cwd: s.cwd, status: s.status, permissionMode: s.permissionMode }));
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  /**
   * Models from the SDK's supportedModels(), cached for the server lifetime.
   * Uses a live SDK session if there is one, otherwise a short-lived query that never sends a prompt.
   * On failure returns FALLBACK_MODELS and retries no sooner than in 5 minutes.
   */
  async models(): Promise<ModelOption[]> {
    if (this.modelsCache) return this.modelsCache;
    if (Date.now() < this.modelsRetryAt) return FALLBACK_MODELS;
    this.modelsLoading ??= this.loadModels().finally(() => (this.modelsLoading = null));
    return this.modelsLoading;
  }

  private async loadModels(): Promise<ModelOption[]> {
    try {
      const live = [...this.sessions.values()].find((s) => s.id)?.q;
      const raw = live ? await withTimeout(live.supportedModels(), MODELS_TIMEOUT_MS) : await this.probeModels();
      const list = (Array.isArray(raw) ? raw : [])
        .filter((m) => m && typeof m.value === 'string' && m.value)
        .map((m) => ({ value: m.value, displayName: m.displayName || m.value, description: m.description || '' }));
      if (list.length) {
        this.modelsCache = list;
        return list;
      }
      throw new Error('empty model list');
    } catch (e) {
      process.stderr.write(`[sdk] supportedModels failed: ${(e as Error).message}\n`);
      this.modelsRetryAt = Date.now() + MODELS_RETRY_MS;
      return FALLBACK_MODELS;
    }
  }

  private async probeModels() {
    const queue = new MessageQueue();
    const q = query({
      prompt: queue,
      options: { cwd: os.homedir(), env: sdkEnv(), stderr: (data: string) => process.stderr.write(`[sdk] ${data}`) },
    });
    try {
      return await withTimeout(q.supportedModels(), MODELS_TIMEOUT_MS);
    } finally {
      queue.close();
      q.close();
    }
  }

  /** Starts a new SDK session; resolves with its session_id once system/init arrives. */
  create(opts: { cwd: string; text: string; uploads: Upload[]; permissionMode: string; model?: string }): Promise<string> {
    if (!opts.cwd || !fs.existsSync(opts.cwd) || !fs.statSync(opts.cwd).isDirectory()) {
      throw new UserError('Папка проекта не найдена');
    }
    if (!MODES.has(opts.permissionMode)) throw new UserError('Неизвестный режим разрешений');
    return this.start(opts.cwd, userMessage(opts.text, opts.uploads), opts.permissionMode, opts.model);
  }

  async resume(sessionId: string, cwd: string, text: string, uploads: Upload[]): Promise<void> {
    if (!cwd || !fs.existsSync(cwd)) throw new UserError('Папка проекта сессии не найдена');
    await this.start(cwd, userMessage(text, uploads), 'auto', undefined, sessionId);
  }

  send(id: string, text: string, uploads: Upload[]): void {
    const s = this.sessions.get(id);
    if (!s) throw new UserError('Сессия не найдена');
    s.queue.push(userMessage(text, uploads));
    clearTimeout(s.idleTimer);
    this.markWorking(s);
  }

  /** Переводит SDK-сессию в working; новый ход (был не working) запускает таймер активности. */
  private markWorking(s: SdkSession): void {
    const was = s.status;
    s.status = 'working';
    if (s.id && was !== 'working') {
      this.hub.emit('working', s.id);
      this.hub.setActivity(s.id, {}, true);
    }
    this.hub.sessionsChanged();
  }

  async interrupt(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) throw new UserError('Сессия не найдена');
    this.hub.pending.cancelWhere((p) => p.sessionId === id);
    await s.q.interrupt();
  }

  async setMode(id: string, mode: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) throw new UserError('Режим можно менять только у сессий, запущенных через cremote');
    if (!MODES.has(mode)) throw new UserError('Неизвестный режим разрешений');
    await s.q.setPermissionMode(mode as PermissionMode);
    s.permissionMode = mode;
    this.hub.sessionsChanged();
  }

  private start(cwd: string, first: SDKUserMessage, mode: string, model?: string, resume?: string): Promise<string> {
    const queue = new MessageQueue();
    queue.push(first);
    let sessionRef: SdkSession | undefined;
    const sessionIdNow = () => sessionRef?.id ?? resume ?? '';

    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      { signal, suggestions }: { signal: AbortSignal; suggestions?: unknown[] },
    ): Promise<PermissionResult> => {
      const sid = sessionIdNow();
      if (toolName === 'AskUserQuestion') {
        const questions = Array.isArray(input.questions) ? input.questions : [];
        const { id, promise } = this.hub.pending.addQuestion(sid, questions);
        const onAbort = () => this.hub.pending.cancel(id);
        signal.addEventListener('abort', onAbort);
        const answer = await promise.finally(() => signal.removeEventListener('abort', onAbort));
        if (!answer) return { behavior: 'deny', message: 'The user dismissed the question.' };
        return { behavior: 'allow', updatedInput: { ...input, questions, answers: answer.answers } };
      }
      const { id, promise } = this.hub.pending.addPermission({
        sessionId: sid,
        toolName,
        input,
        ...(suggestions?.length ? { suggestions } : {}),
      });
      const onAbort = () => this.hub.pending.cancel(id);
      signal.addEventListener('abort', onAbort);
      const answer = await promise.finally(() => signal.removeEventListener('abort', onAbort));
      if (!answer) return { behavior: 'deny', message: 'Cancelled from cremote.' };
      if (answer.behavior === 'allow') {
        return {
          behavior: 'allow',
          updatedInput: input,
          ...(answer.updatedPermissions?.length ? { updatedPermissions: answer.updatedPermissions as any } : {}),
        };
      }
      return { behavior: 'deny', message: answer.message || 'Denied from cremote.' };
    };

    const q = query({
      prompt: queue,
      options: {
        cwd,
        permissionMode: mode as PermissionMode,
        ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
        ...(model ? { model } : {}),
        ...(resume ? { resume } : {}),
        canUseTool: canUseTool as any,
        env: sdkEnv(),
        stderr: (data: string) => process.stderr.write(`[sdk] ${data}`),
      },
    });

    const session: SdkSession = { cwd, q, queue, status: 'working', permissionMode: mode };
    sessionRef = session;
    if (resume) {
      session.id = resume;
      this.sessions.set(resume, session);
      this.hub.sessionsChanged();
    }

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(session.id!);
      };
      void (async () => {
        try {
          for await (const msg of q) {
            if (msg.type === 'system' && msg.subtype === 'init') {
              if (!session.id) {
                session.id = msg.session_id;
                this.sessions.set(msg.session_id, session);
              }
              // Первый ход нового или возобновлённого процесса начался с отправки промпта.
              this.hub.emit('working', session.id);
              this.hub.setActivity(session.id!, {}, true);
              this.hub.sessionsChanged();
              settle();
            } else if (msg.type === 'result') {
              const wasWorking = session.status === 'working';
              session.status = 'awaiting_input';
              if (session.id) {
                this.hub.setActivity(session.id, null);
                if (wasWorking) this.hub.emit('turnend', session.id);
              }
              clearTimeout(session.idleTimer);
              session.idleTimer = setTimeout(() => queue.close(), IDLE_CLOSE_MS);
              this.hub.sessionsChanged();
            } else if (msg.type === 'assistant') {
              if (session.status !== 'working') this.markWorking(session);
              if (session.id && !msg.parent_tool_use_id) {
                const blocks: any[] = Array.isArray((msg as any).message?.content) ? (msg as any).message.content : [];
                const tool = [...blocks].reverse().find((b) => b?.type === 'tool_use');
                if (tool) this.hub.setActivity(session.id, { tool: tool.name, hint: toolHint(tool.input), writing: undefined });
                else if (blocks.some((b) => b?.type === 'text' && b.text)) this.hub.setActivity(session.id, { tool: undefined, hint: undefined, writing: true });
              }
            } else if (msg.type === 'user' && session.id && !(msg as any).parent_tool_use_id) {
              const c = (msg as any).message?.content;
              if (Array.isArray(c) && c.some((b: any) => b?.type === 'tool_result')) {
                this.hub.setActivity(session.id, { tool: undefined, hint: undefined, writing: undefined });
              }
            }
          }
          settle(new UserError('Сессия завершилась до инициализации'));
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error(`[sdk] session ${session.id ?? '(new)'} failed: ${message}`);
          if (session.id) this.hub.emit('notify', { sessionId: session.id, title: 'Ошибка SDK', message });
          settle(new UserError(`Не удалось запустить сессию: ${message}`));
        } finally {
          clearTimeout(session.idleTimer);
          queue.close();
          if (session.id && this.sessions.get(session.id) === session) {
            this.sessions.delete(session.id);
            this.hub.setActivity(session.id, null);
            this.hub.pending.cancelWhere((p) => p.sessionId === session.id);
            // Not hook-reported, so the session falls back to 'history' and can be resumed again.
            this.hub.sessionsChanged();
          }
        }
      })();
    });
  }
}
