export type SessionStatus = 'live' | 'working' | 'idle' | 'awaiting_input' | 'ended' | 'history';
export type SessionSource = 'vscode' | 'cli' | 'sdk' | 'unknown';
export type PermissionModeName = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk' | 'auto';

/** Что Claude делает в текущем ходе (только при status working). */
export interface Activity {
  /** Начало хода, мс с эпохи. */
  since: number;
  /** Инструмент, который выполняется сейчас (от PreToolUse до PostToolUse). */
  tool?: string;
  /** Команда, имя файла или шаблон, до 40 символов. */
  hint?: string;
  /** Claude пишет текст ответа (только SDK-сессии). */
  writing?: boolean;
}

export interface SessionInfo {
  id: string;
  cwd: string;
  project: string;
  title: string;
  mtime: number;
  status: SessionStatus;
  source: SessionSource;
  permissionMode?: string;
  /** A Claude Code process (VS Code tab or CLI) is running this session. */
  open: boolean;
  /** Phone messages waiting for the next Stop hook (hook sessions only). */
  queued?: { id: string; text: string; attachments: string[]; createdAt: number }[];
  activity?: Activity;
  /** open was inferred from cwd and transcript mtime, not from argv or hooks. */
  openGuess?: boolean;
  /** Process start time, ms. */
  openSince?: number;
}

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'image'; mediaType: string; data: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; isError: boolean; text: string }
  | { kind: 'hook_feedback'; text: string }
  | MetaBlock;

/** Kind of a harness-injected entry, see docs/SPEC.md «Транскрипты». */
export type SystemKind = 'agent_report' | 'agent_message' | 'task' | 'command' | 'interrupt' | 'notice';

export interface MetaBlock {
  kind: 'meta';
  text: string;
  /** What injected the entry. Absent on entries the server could not classify. */
  sys?: SystemKind;
  /** One-line caption: agent name and first report line, task summary, command name. */
  summary?: string;
  /** Text for the expanded view without the harness frame (subagent report, task result). */
  body?: string;
  /** task only: completed | failed | killed | … as written by Claude Code. */
  status?: string;
}

export interface Message {
  uuid: string;
  role: 'user' | 'assistant';
  timestamp: string;
  blocks: Block[];
  isSidechain: boolean;
}

export type Pending =
  | {
      id: string;
      kind: 'permission';
      sessionId: string;
      toolName: string;
      input: unknown;
      suggestions?: unknown[];
      /** Card created from PermissionDenied: the auto-mode classifier blocked the call. */
      blocked?: boolean;
      reason?: string;
      createdAt: number;
    }
  | { id: string; kind: 'question'; sessionId: string; questions: unknown[]; createdAt: number };

export type PermissionAnswer = {
  behavior: 'allow' | 'deny';
  message?: string;
  updatedPermissions?: unknown[];
};

export type QuestionAnswer = { answers: Record<string, string> };

/** Thrown for user-facing errors that should reach the WS client verbatim. */
export class UserError extends Error {}
