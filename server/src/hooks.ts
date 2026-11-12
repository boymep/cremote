import type { Hub } from './hub.js';
import { INTERRUPT_REASON, toolHint } from './hub.js';

const DEBUG = process.env.CREMOTE_DEBUG_HOOKS === '1';

type HookInput = Record<string, any>;
type HookReply = Record<string, unknown>;

export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Notification',
  'PermissionRequest',
  'PreToolUse',
  'PermissionDenied',
  'PostToolUse',
  'Stop',
  // Not a Claude Code event: the async asyncRewake hook that wakes an idle session (see cremote-hook.mjs).
  'Wait',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

function sameInput(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Handles one hook call from cremote-hook.mjs. `signal` aborts when the hook process
 * goes away (Claude Code killed it because the user answered locally).
 */
export async function handleHook(hub: Hub, event: HookEvent, input: HookInput, signal: AbortSignal): Promise<HookReply> {
  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
  if (!sessionId) return {};
  if (DEBUG) console.log(`[hook] ${event} ${sessionId.slice(0, 8)}${input.tool_name ? ` ${input.tool_name}` : ''}`);
  const base = { cwd: typeof input.cwd === 'string' ? input.cwd : undefined };
  if (event === 'Stop') hub.accounts?.onStop();
  if (typeof input.transcript_path === 'string') {
    hub.transcripts.noteFile(input.transcript_path);
  }

  switch (event) {
    case 'SessionStart':
      // Compaction restarts the session mid-turn: it is still working.
      if (input.source !== 'compact') hub.setLive(sessionId, { ...base, status: 'live', interruptRequested: false });
      return {};
    case 'SessionEnd':
      hub.live.get(sessionId)?.waker?.(null);
      hub.setLive(sessionId, { ...base, status: 'ended', interruptRequested: false });
      hub.releaseHookPending((p) => p.sessionId === sessionId);
      return {};
    case 'UserPromptSubmit':
      // Typed in VS Code: the idle waiter is moot, the next Stop starts a new one.
      hub.live.get(sessionId)?.waker?.(null);
      hub.setLive(sessionId, { ...base, status: 'working', interruptRequested: false });
      // Новый ход: таймер идёт с нуля, даже если сессия уже была working.
      hub.setActivity(sessionId, { tool: undefined, hint: undefined }, true);
      return {};
    case 'Notification':
      // «Claude ждёт ввода» после минуты простоя: об этом уже сообщил push о конце работы.
      if (input.notification_type === 'idle_prompt') return {};
      hub.emit('notify', {
        sessionId,
        title: typeof input.title === 'string' ? input.title : 'Claude Code',
        message: typeof input.message === 'string' ? input.message : '',
      });
      return {};
    case 'PostToolUse':
      hub.setLive(sessionId, { ...base, status: 'working' });
      if (!input.agent_id) hub.setActivity(sessionId, { tool: undefined, hint: undefined });
      // The tool already ran, so a card for it was answered locally (Claude Code does not always kill the hook).
      hub.releaseHookPending(
        (p) =>
          p.sessionId === sessionId &&
          (p.kind === 'question'
            ? input.tool_name === 'AskUserQuestion'
            : p.id === toolUseKey.get(input.tool_use_id) || (p.toolName === input.tool_name && sameInput(p.input, input.tool_input))),
      );
      return postToolUse(hub, sessionId, input);
    case 'PermissionRequest':
      return permissionRequest(hub, sessionId, base, input, signal);
    case 'PermissionDenied':
      return permissionDenied(hub, sessionId, input, signal);
    case 'PreToolUse':
      return preToolUse(hub, sessionId, base, input);
    case 'Stop':
      return stop(hub, sessionId, base);
    case 'Wait':
      return wait(hub, sessionId, signal);
  }
}

/** tool_use_id -> pending id, when Claude Code passes tool_use_id to PermissionRequest. */
const toolUseKey = new Map<string, string>();

async function permissionRequest(
  hub: Hub,
  sessionId: string,
  base: { cwd?: string },
  input: HookInput,
  signal: AbortSignal,
): Promise<HookReply> {
  hub.setLive(sessionId, { ...base, status: 'working' });
  if (!hub.phonePresent()) return {};
  // Claude Code runs PermissionRequest for AskUserQuestion too (verified with stream-json + stdio
  // permission prompt, as in VS Code), so the question races with the local UI: first answer wins.
  if (input.tool_name === 'AskUserQuestion') return askQuestion(hub, sessionId, input, signal);

  const { id, promise } = hub.pending.addPermission({
    sessionId,
    toolName: String(input.tool_name ?? ''),
    input: input.tool_input ?? {},
    ...(Array.isArray(input.permission_suggestions) ? { suggestions: input.permission_suggestions } : {}),
  });
  hub.hookPending.add(id);
  const tuid = typeof input.tool_use_id === 'string' ? input.tool_use_id : undefined;
  if (tuid) toolUseKey.set(tuid, id);
  const onAbort = () => hub.pending.cancel(id);
  signal.addEventListener('abort', onAbort);
  try {
    const answer = await promise;
    if (!answer) return {};
    const decision: Record<string, unknown> =
      answer.behavior === 'allow'
        ? {
            behavior: 'allow',
            ...(answer.updatedPermissions?.length ? { updatedPermissions: answer.updatedPermissions } : {}),
          }
        : { behavior: 'deny', message: answer.message || 'Denied from cremote' };
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  } finally {
    signal.removeEventListener('abort', onAbort);
    hub.hookPending.delete(id);
    if (tuid) toolUseKey.delete(tuid);
  }
}

/**
 * Auto-mode classifier blocked a call. With the phone present, asks the user; on allow stores a one-shot
 * approval that PreToolUse consumes on the retry, and tells the model it may retry.
 */
async function permissionDenied(hub: Hub, sessionId: string, input: HookInput, signal: AbortSignal): Promise<HookReply> {
  if (!hub.phonePresent()) return {};
  const toolName = String(input.tool_name ?? '');
  const { id, promise } = hub.pending.addPermission({
    sessionId,
    toolName,
    input: input.tool_input ?? {},
    blocked: true,
    reason: typeof input.reason === 'string' ? input.reason : '',
  });
  hub.hookPending.add(id);
  const onAbort = () => hub.pending.cancel(id);
  signal.addEventListener('abort', onAbort);
  try {
    const answer = await promise;
    if (answer?.behavior !== 'allow') return {};
    hub.addApproval(sessionId, toolName, input.tool_input);
    return { hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: true } };
  } finally {
    signal.removeEventListener('abort', onAbort);
    hub.hookPending.delete(id);
  }
}

function denyForInterrupt(): HookReply {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: INTERRUPT_REASON,
    },
  };
}

function preToolUse(hub: Hub, sessionId: string, base: { cwd?: string }, input: HookInput): HookReply {
  const live = hub.setLive(sessionId, { ...base, status: 'working' });
  if (typeof input.tool_name === 'string' && !input.agent_id) {
    hub.setActivity(sessionId, { tool: input.tool_name, hint: toolHint(input.tool_input) });
  }
  if (live.interruptRequested) {
    hub.setLive(sessionId, { interruptRequested: false });
    return denyForInterrupt();
  }
  if (typeof input.tool_name === 'string' && hub.takeApproval(sessionId, input.tool_name, input.tool_input)) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Approved by the user from phone (cremote) after classifier block',
      },
    };
  }
  return {};
}

async function askQuestion(hub: Hub, sessionId: string, input: HookInput, signal: AbortSignal): Promise<HookReply> {
  const questions = Array.isArray(input.tool_input?.questions) ? input.tool_input.questions : [];
  const { id, promise } = hub.pending.addQuestion(sessionId, questions);
  hub.hookPending.add(id);
  const onAbort = () => hub.pending.cancel(id);
  signal.addEventListener('abort', onAbort);
  try {
    const answer = await promise;
    if (!answer) {
      if (hub.live.get(sessionId)?.interruptRequested) {
        hub.setLive(sessionId, { interruptRequested: false });
        return {
          hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: INTERRUPT_REASON } },
        };
      }
      return {};
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: { ...input.tool_input, questions, answers: answer.answers } },
      },
    };
  } finally {
    signal.removeEventListener('abort', onAbort);
    hub.hookPending.delete(id);
  }
}

/**
 * Mid-turn delivery: phone messages queued while Claude works reach it at the next tool boundary.
 * Tool calls inside a subagent carry `agent_id`; the message must go to the main agent, so they are skipped.
 */
function postToolUse(hub: Hub, sessionId: string, input: HookInput): HookReply {
  if (typeof input.agent_id === 'string' && input.agent_id) return {};
  const queued = hub.takeQueued(sessionId);
  if (queued === null) return {};
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: queued } };
}

/** Never waits: delivers already-queued phone messages as a block reason, otherwise lets Claude stop. */
function stop(hub: Hub, sessionId: string, base: { cwd?: string }): HookReply {
  const queued = hub.takeQueued(sessionId);
  if (queued !== null) {
    hub.setLive(sessionId, { ...base, status: 'working', interruptRequested: false });
    return { decision: 'block', reason: queued };
  }
  hub.setLive(sessionId, { ...base, status: 'idle', interruptRequested: false });
  hub.emit('turnend', sessionId);
  return {};
}

/**
 * Async `asyncRewake` hook started on Stop and SessionStart. Claude Code does not wait for it.
 * Resolves with `{wake: text}` when a phone message arrives for the idle session (the hook exits 2 and
 * Claude Code starts a turn with it), or `{}` when it is replaced, the user types locally or the session ends.
 */
async function wait(hub: Hub, sessionId: string, signal: AbortSignal): Promise<HookReply> {
  const text = await new Promise<string | null>((resolve) => {
    const done = (t: string | null) => {
      signal.removeEventListener('abort', onAbort);
      if (hub.live.get(sessionId)?.waker === done) hub.setLive(sessionId, { waker: undefined });
      resolve(t);
    };
    const onAbort = () => {
      if (DEBUG) console.log(`[hook] Wait ${sessionId.slice(0, 8)} closed`);
      done(null);
    };
    signal.addEventListener('abort', onAbort);
    hub.live.get(sessionId)?.waker?.(null);
    hub.setLive(sessionId, { waker: done });
    // A message may have been queued between the last tool call and now.
    hub.wakeIfIdle(sessionId);
  });
  return text === null ? {} : { wake: text };
}
