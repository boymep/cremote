import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOOK_SCRIPT } from './config.js';

const MARKER = 'cremote-hook.mjs';
const BLOCK_CAP_ENV = 'CLAUDE_CODE_STOP_HOOK_BLOCK_CAP';
const BLOCK_CAP = '10000';

/**
 * Async hooks still obey `timeout` (verified: a 3 s timeout kills the waiter), so the idle waiter gets
 * a week. It must stay below 2^31 ms, Node's setTimeout limit.
 */
const WAIT_TIMEOUT = 7 * 24 * 3600;
/** The idle waiter: Claude Code does not wait for it; exit 2 wakes the session (see cremote-hook.mjs). */
const WAIT_HOOK = { script: 'Wait', timeout: WAIT_TIMEOUT, async: true, asyncRewake: true };

const HOOKS: { event: string; matcher?: string; timeout: number; extra?: (typeof WAIT_HOOK)[] }[] = [
  { event: 'SessionStart', timeout: 5, extra: [WAIT_HOOK] },
  { event: 'SessionEnd', timeout: 5 },
  { event: 'UserPromptSubmit', timeout: 5 },
  { event: 'Notification', timeout: 5 },
  { event: 'PermissionRequest', matcher: '*', timeout: 86400 },
  { event: 'PreToolUse', matcher: '*', timeout: 86400 },
  { event: 'PermissionDenied', matcher: '*', timeout: 86400 },
  { event: 'PostToolUse', matcher: '*', timeout: 5 },
  // Stop never waits: it only hands over messages that are already queued.
  { event: 'Stop', timeout: 10, extra: [WAIT_HOOK] },
];

export function settingsPath(): string {
  return process.env.CREMOTE_CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
}

const quote = (s: string) => (/^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Absolute node path: VS Code launched from the Dock may not have node on PATH. */
export function hookCommand(event: string): string {
  return `${quote(process.execPath)} ${quote(HOOK_SCRIPT)} ${event}`;
}

type Settings = Record<string, any>;

function readSettings(file: string): Settings {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Settings;
}

function writeSettings(file: string, s: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
}

function backup(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  const dest = `${file}.cremote-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, dest);
  return dest;
}

/** Removes every hook entry whose command mentions cremote-hook.mjs; drops emptied groups/events. */
function stripOurs(s: Settings): void {
  if (!s.hooks || typeof s.hooks !== 'object') return;
  for (const event of Object.keys(s.hooks)) {
    const groups = Array.isArray(s.hooks[event]) ? s.hooks[event] : [];
    const kept = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const hooks = g.hooks.filter((h: any) => !(typeof h?.command === 'string' && h.command.includes(MARKER)));
      if (hooks.length) kept.push({ ...g, hooks });
    }
    if (kept.length) s.hooks[event] = kept;
    else delete s.hooks[event];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
}

export function installHooks(): { file: string; backup: string | null } {
  const file = settingsPath();
  const s = readSettings(file);
  const bak = backup(file);
  stripOurs(s);
  s.hooks ??= {};
  for (const h of HOOKS) {
    const group: Record<string, unknown> = {};
    if (h.matcher) group.matcher = h.matcher;
    group.hooks = [
      { type: 'command', command: hookCommand(h.event), timeout: h.timeout },
      ...(h.extra ?? []).map(({ script, ...rest }) => ({ type: 'command', command: hookCommand(script), ...rest })),
    ];
    s.hooks[h.event] = [...(Array.isArray(s.hooks[h.event]) ? s.hooks[h.event] : []), group];
  }
  s.env = { ...(s.env ?? {}), [BLOCK_CAP_ENV]: BLOCK_CAP };
  writeSettings(file, s);
  return { file, backup: bak };
}

export function uninstallHooks(): { file: string; backup: string | null } {
  const file = settingsPath();
  if (!fs.existsSync(file)) return { file, backup: null };
  const s = readSettings(file);
  const bak = backup(file);
  stripOurs(s);
  if (s.env?.[BLOCK_CAP_ENV] === BLOCK_CAP) {
    delete s.env[BLOCK_CAP_ENV];
    if (!Object.keys(s.env).length) delete s.env;
  }
  writeSettings(file, s);
  return { file, backup: bak };
}

/** Every cremote hook command currently in settings.json, grouped by event. */
export function listInstalledHooks(): { file: string; byEvent: Record<string, string[]> } {
  const file = settingsPath();
  const byEvent: Record<string, string[]> = {};
  let s: Settings = {};
  try {
    s = readSettings(file);
  } catch {
    return { file, byEvent };
  }
  for (const [event, groups] of Object.entries(s.hooks ?? {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        if (typeof h?.command === 'string' && h.command.includes(MARKER)) (byEvent[event] ??= []).push(h.command);
      }
    }
  }
  return { file, byEvent };
}

export const EXPECTED_HOOK_EVENTS = HOOKS.map((h) => h.event);
