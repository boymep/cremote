// Типы протокола cremote. Зеркало docs/SPEC.md, разделы «Транскрипты», «WebSocket /ws», HTTP.

export type SessionStatus = 'live' | 'working' | 'idle' | 'awaiting_input' | 'ended' | 'history';
export type SessionSource = 'vscode' | 'cli' | 'sdk' | 'unknown';
/** Совпадает с PermissionMode из @anthropic-ai/claude-agent-sdk. */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk';

export interface SessionInfo {
  id: string;
  cwd: string;
  /** basename(cwd) */
  project: string;
  title: string;
  /** Время изменения, мс с эпохи (или ISO-строка, сервер может прислать любое). */
  mtime: number | string;
  status: SessionStatus;
  source: SessionSource;
  permissionMode?: PermissionMode;
  /** Вкладка Claude открыта в VS Code или CLI запущен. Нет поля — считаем false. */
  open?: boolean;
  /** open определён эвристикой (по времени изменения транскрипта). */
  openGuess?: boolean;
  /** С какого момента открыта, мс. */
  openSince?: number;
  /** Сообщения с телефона, которые ждут конца ответа Claude. */
  queued?: QueuedMessage[];
  /** Что Claude делает в текущем ходе. Есть только при status working. */
  activity?: Activity;
}

export interface Activity {
  /** Начало хода, мс с эпохи. */
  since: number;
  /** Инструмент, который выполняется сейчас. */
  tool?: string;
  /** Команда, имя файла или шаблон, до 40 символов. */
  hint?: string;
  /** Claude пишет текст ответа (только SDK-сессии). */
  writing?: boolean;
}

export interface QueuedMessage {
  id: string;
  text: string;
  /** id загрузок. */
  attachments: string[];
  createdAt: number | string;
}

// ---- Сообщения транскрипта ----

export interface TextBlock {
  kind: 'text';
  text: string;
}
export interface ThinkingBlock {
  kind: 'thinking';
  text: string;
}
export interface ImageBlock {
  kind: 'image';
  mediaType: string;
  data: string;
}
export interface ToolUseBlock {
  kind: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultBlock {
  kind: 'tool_result';
  toolUseId: string;
  isError: boolean;
  text: string;
}
export interface HookFeedbackBlock {
  kind: 'hook_feedback';
  text: string;
}
/** Кто вставил служебную запись в транскрипт. */
export type SystemKind = 'agent_report' | 'agent_message' | 'task' | 'command' | 'interrupt' | 'notice';

export interface MetaBlock {
  kind: 'meta';
  /** Исходный текст записи целиком. */
  text: string;
  /** Тип записи. Нет поля — сервер не распознал запись (или старый сервер). */
  sys?: SystemKind;
  /** Подпись в одну строку: имя агента и первая строка отчёта, итог задачи, команда. */
  summary?: string;
  /** Текст для раскрытого вида без служебной рамки: отчёт сабагента, итог задачи. */
  body?: string;
  /** Только для task: completed, failed, stopped, killed — как пишет Claude Code. */
  status?: string;
}

export type Block =
  | TextBlock
  | ThinkingBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | HookFeedbackBlock
  | MetaBlock;

export interface Message {
  uuid: string;
  role: 'user' | 'assistant';
  timestamp: string;
  blocks: Block[];
  isSidechain: boolean;
}

// ---- Pending ----

export interface PermissionSuggestion {
  [key: string]: unknown;
}

export interface PendingPermission {
  id: string;
  kind: 'permission';
  sessionId: string;
  toolName: string;
  input: unknown;
  suggestions?: PermissionSuggestion[];
  /** Заблокировано классификатором auto-режима (хук PermissionDenied). */
  blocked?: boolean;
  reason?: string;
  createdAt: number | string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface PendingQuestion {
  id: string;
  kind: 'question';
  sessionId: string;
  questions: Question[];
  createdAt: number | string;
}

export type Pending = PendingPermission | PendingQuestion;

// ---- Аккаунты и лимиты (SPEC «Аккаунты и лимиты») ----

export interface AccountWindow {
  id: 'fiveHour' | 'sevenDay';
  label: string;
  /** Израсходовано, проценты 0–100. */
  pct: number;
  resetsAt: string | null;
}

export interface AccountItem {
  number: number | null;
  email: string;
  org?: string;
  alias?: string;
  /** Отображаемое имя из общего файла names.json. */
  name?: string;
  active: boolean;
  /** Аккаунт исключён из ротации cswap. */
  disabled?: boolean;
  /** "ok" — лимиты известны; иначе причина, почему их нет. */
  usageStatus: string;
  windows: AccountWindow[];
  loginExpiresAt?: string;
}

export interface Accounts {
  activeNumber: number | null;
  fetchedAt: string;
  items: AccountItem[];
  error?: string;
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  canUpdate: boolean;
  autoUpdate: 'notify' | 'auto' | 'off';
}

// ---- Сервер → клиент ----

export type ServerMessage =
  | {
      type: 'hello';
      /** Устарело: переключателя «Управление» больше нет, поле игнорируется. */
      remoteAccess?: boolean;
      sessions: SessionInfo[];
      pending: Pending[];
      accounts?: Accounts | null;
    }
  | { type: 'accounts'; accounts: Accounts | null }
  | { type: 'update'; current: string; latest: string | null; available: boolean; canUpdate: boolean; autoUpdate: 'notify' | 'auto' | 'off' }
  | { type: 'sessions'; sessions: SessionInfo[] }
  | { type: 'remote'; enabled: boolean }
  | { type: 'pending'; pending: Pending[] }
  | {
      type: 'messages';
      sessionId: string;
      messages: Message[];
      mode: 'replace' | 'append' | 'prepend';
      hasMore: boolean;
    }
  | { type: 'notify'; sessionId: string; title: string; message: string }
  | { type: 'error'; requestId?: string; message: string }
  | { type: 'ok'; requestId: string; queued?: boolean };

// ---- Клиент → сервер ----

export type ClientMessageBody =
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe'; sessionId: string }
  | { type: 'load_more'; sessionId: string; before: string }
  | { type: 'set_remote'; enabled: boolean }
  | {
      type: 'answer_permission';
      id: string;
      behavior: 'allow' | 'deny';
      message?: string;
      updatedPermissions?: PermissionSuggestion[];
    }
  | { type: 'answer_question'; id: string; answers: Record<string, string> }
  | { type: 'send_message'; sessionId: string; text: string; attachments: string[] }
  | { type: 'interrupt'; sessionId: string }
  | {
      type: 'create_session';
      cwd: string;
      text: string;
      attachments: string[];
      permissionMode: PermissionMode;
      model?: string;
    }
  | { type: 'set_mode'; sessionId: string; mode: PermissionMode }
  | { type: 'switch_account'; number: number }
  | { type: 'refresh_accounts' }
  | { type: 'run_update' }
  | { type: 'cancel_queued'; sessionId: string; id: string }
  | { type: 'presence'; visible: boolean };

export type ClientMessage = ClientMessageBody & { requestId?: string };

// ---- HTTP ----

export interface UploadResponse {
  id: string;
  path: string;
  mediaType: string;
}

export interface ModelOption {
  value: string;
  displayName: string;
  description: string;
}

/** Режимы, названия и описания как в выборе режима Claude Code в VS Code. Auto — первым, Bypass — последним, приглушённо. */
export const PERMISSION_MODES: { value: PermissionMode; label: string; hint: string; muted?: boolean }[] = [
  {
    value: 'auto',
    label: 'Auto',
    hint: 'Claude will approve actions that pass a safety check and pause for anything risky',
  },
  { value: 'default', label: 'Manual', hint: 'Claude will ask for approval before making each edit' },
  { value: 'acceptEdits', label: 'Edit automatically', hint: 'Claude will edit your selected text or the whole file' },
  { value: 'plan', label: 'Plan', hint: 'Claude will explore the code and present a plan before editing' },
  {
    value: 'bypassPermissions',
    label: 'Bypass permissions',
    hint: 'Claude will run everything without asking',
    muted: true,
  },
];

/** Режим новой сессии по умолчанию (SDK поддерживает "auto"). */
export const DEFAULT_NEW_SESSION_MODE: PermissionMode = 'auto';

/** Режимы, которых нет в селекторе, но которые сессия может уже иметь. */
const EXTRA_MODE_LABELS: Record<string, string> = { dontAsk: "Don't ask" };

export function modeLabel(mode: string): string {
  return PERMISSION_MODES.find((m) => m.value === mode)?.label ?? EXTRA_MODE_LABELS[mode] ?? mode;
}

export function modeHint(mode: string | undefined): string {
  return PERMISSION_MODES.find((m) => m.value === mode)?.hint ?? '';
}
