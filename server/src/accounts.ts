import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readConfig } from './config.js';
import type { Hub } from './hub.js';
import { UserError } from './types.js';

const POLL_MS = 60_000;
const HOOK_GAP_MS = 20_000;
const MANUAL_GAP_MS = 10_000;
const LIST_TIMEOUT_MS = 30_000;
const SWITCH_TIMEOUT_MS = 120_000;

export interface AccountWindow {
  id: 'fiveHour' | 'sevenDay';
  label: string;
  pct: number;
  resetsAt: string | null;
}

export interface AccountItem {
  number: number | null;
  email: string;
  org?: string;
  alias?: string;
  name?: string;
  active: boolean;
  disabled?: boolean;
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

const WINDOWS: { id: AccountWindow['id']; label: string }[] = [
  { id: 'fiveHour', label: '5 ч' },
  { id: 'sevenDay', label: '7 дней' },
];

/** launchd and VS Code often start without ~/.local/bin on PATH. */
function childEnv(): NodeJS.ProcessEnv {
  const extra = [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return { ...process.env, PATH: [...current, ...extra.filter((p) => !current.includes(p))].join(path.delimiter), NO_COLOR: '1' };
}

function cswapBin(): string {
  const custom = readConfig()?.cswapPath;
  if (custom) return custom;
  const local = path.join(os.homedir(), '.local', 'bin', 'cswap');
  return fs.existsSync(local) ? local : 'cswap';
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  missing: boolean;
}

function runCswap(args: string[], timeout: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cswapBin(), args, { timeout, env: childEnv(), maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      let code = 0;
      let missing = false;
      if (err) {
        const c = (err as NodeJS.ErrnoException).code as unknown;
        if (c === 'ENOENT' || c === 'EACCES') missing = true;
        code = typeof c === 'number' ? c : 1;
      }
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), missing });
    });
  });
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorText(res: RunResult, data: any): string {
  if (res.missing) return 'cswap не найден. Укажите путь в cswapPath в ~/.cremote/config.json';
  const e = data?.error;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') return String(e.message || e.detail || e.type || e.code || 'неизвестная ошибка');
  return res.stderr.trim().split('\n').pop() || `код ${res.code}`;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Maps `cswap list --json`; copies only whitelisted fields so nothing sensitive leaks. */
export function mapList(data: any): Accounts {
  const items: AccountItem[] = (Array.isArray(data?.accounts) ? data.accounts : []).map((a: any) => {
    const windows: AccountWindow[] = [];
    for (const w of WINDOWS) {
      const u = a?.usage?.[w.id];
      if (u && typeof u.pct === 'number') windows.push({ id: w.id, label: w.label, pct: u.pct, resetsAt: isoOrNull(u.resetsAt) });
    }
    const item: AccountItem = {
      number: typeof a?.number === 'number' ? a.number : null,
      email: String(a?.email ?? ''),
      active: !!a?.active,
      usageStatus: typeof a?.usageStatus === 'string' ? a.usageStatus : 'unavailable',
      windows,
    };
    if (typeof a?.organizationName === 'string' && a.organizationName) item.org = a.organizationName;
    if (typeof a?.alias === 'string' && a.alias) item.alias = a.alias;
    if (a?.disabled) item.disabled = true;
    const exp = isoOrNull(a?.loginExpiresAt);
    if (exp) item.loginExpiresAt = exp;
    return item;
  });
  return {
    activeNumber: typeof data?.activeAccountNumber === 'number' ? data.activeAccountNumber : null,
    fetchedAt: new Date().toISOString(),
    items,
  };
}

/** ~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json when set: Claude Code keeps oauthAccount there. */
function claudeJsonPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (dir && fs.existsSync(path.join(dir, '.claude.json'))) return path.join(dir, '.claude.json');
  return path.join(os.homedir(), '.claude.json');
}

function readOauthAccount(): { email: string; org?: string; key: string } | null {
  try {
    const a = JSON.parse(fs.readFileSync(claudeJsonPath(), 'utf8'))?.oauthAccount;
    if (!a || typeof a.emailAddress !== 'string') return null;
    return {
      email: a.emailAddress,
      ...(typeof a.organizationName === 'string' && a.organizationName ? { org: a.organizationName } : {}),
      key: `${a.emailAddress}|${a.organizationUuid ?? ''}`,
    };
  } catch {
    return null;
  }
}

/** Shared display names written by the VS Code extension. CREMOTE_ACCOUNT_NAMES overrides the path (tests). */
function namesPath(): string {
  return process.env.CREMOTE_ACCOUNT_NAMES || path.join(os.homedir(), '.config', 'claude-accounts', 'names.json');
}

function readNames(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const names = JSON.parse(fs.readFileSync(namesPath(), 'utf8'))?.names;
    if (names && typeof names === 'object') {
      for (const [k, v] of Object.entries(names)) if (typeof v === 'string' && v.trim()) out.set(k, v.trim());
    }
  } catch {
    /* missing or broken file = no names */
  }
  return out;
}

/** Adds `name` by exact email, then case-insensitive. Returns a new object. */
export function applyNames(acc: Accounts, names: Map<string, string> = readNames()): Accounts {
  const lower = new Map<string, string>();
  for (const [k, v] of names) if (!lower.has(k.toLowerCase())) lower.set(k.toLowerCase(), v);
  return {
    ...acc,
    items: acc.items.map((it) => {
      const { name: _old, ...rest } = it;
      const name = names.get(it.email) ?? lower.get(it.email.toLowerCase());
      return name ? { ...rest, name } : rest;
    }),
  };
}

function fallback(error: string): Accounts {
  const a = readOauthAccount();
  return {
    activeNumber: null,
    fetchedAt: new Date().toISOString(),
    items: a ? [{ number: null, email: a.email, ...(a.org ? { org: a.org } : {}), active: true, usageStatus: 'unavailable', windows: [] }] : [],
    error,
  };
}

/**
 * Claude accounts and plan limits via the user's cswap CLI.
 * Polls only while WS clients are connected; never runs two cswap processes at once.
 * Emits hub 'accounts'.
 */
export class AccountsMonitor {
  accounts: Accounts | null = null;
  private clients = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private pollTimer?: NodeJS.Timeout;
  private hookTimer?: NodeJS.Timeout;
  private fileTimer?: NodeJS.Timeout;
  private watcher?: fs.FSWatcher;
  private namesWatcher?: fs.FSWatcher;
  private namesTimer?: NodeJS.Timeout;
  private lastFetch = 0;
  private refreshing?: Promise<Accounts>;
  private oauthKey: string | null = null;

  constructor(private hub: Hub) {}

  start(): void {
    this.oauthKey = readOauthAccount()?.key ?? null;
    const file = claudeJsonPath();
    try {
      // Claude Code rewrites the file atomically, which breaks a plain file watcher; watch the directory.
      this.watcher = fs.watch(path.dirname(file), (_e, name) => {
        if (name && name.toString() !== path.basename(file)) return;
        clearTimeout(this.fileTimer);
        this.fileTimer = setTimeout(() => this.onClaudeJsonChange(), 1000);
      });
      this.watcher.on('error', () => this.watcher?.close());
    } catch {
      /* polling still works */
    }
  }

  /** Lazily watches the names directory; the directory may not exist yet, so every poll retries. */
  private ensureNamesWatcher(): void {
    if (this.namesWatcher) return;
    const file = namesPath();
    try {
      const w = fs.watch(path.dirname(file), (_e, name) => {
        if (name && name.toString() !== path.basename(file)) return;
        clearTimeout(this.namesTimer);
        this.namesTimer = setTimeout(() => this.onNamesChange(), 300);
      });
      w.on('error', () => {
        w.close();
        if (this.namesWatcher === w) this.namesWatcher = undefined;
      });
      this.namesWatcher = w;
    } catch {
      /* directory missing: retry on the next poll */
    }
  }

  private onNamesChange(): void {
    if (!this.accounts) return;
    const next = applyNames(this.accounts);
    if (JSON.stringify(next.items) === JSON.stringify(this.accounts.items)) return;
    this.accounts = next;
    this.hub.emit('accounts', next);
  }

  stop(): void {
    this.watcher?.close();
    this.namesWatcher?.close();
    clearTimeout(this.namesTimer);
    clearInterval(this.pollTimer);
    clearTimeout(this.hookTimer);
    clearTimeout(this.fileTimer);
  }

  /** The file changes on every session write; only an account change triggers a refresh. */
  private onClaudeJsonChange(): void {
    const key = readOauthAccount()?.key ?? null;
    if (key === this.oauthKey) return;
    this.oauthKey = key;
    void this.refresh();
  }

  setClients(n: number): void {
    this.clients = n;
    if (n > 0 && !this.pollTimer) {
      this.pollTimer = setInterval(() => void this.refresh(), POLL_MS);
      if (Date.now() - this.lastFetch >= POLL_MS) void this.refresh();
    } else if (n === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
      clearTimeout(this.hookTimer);
      this.hookTimer = undefined;
    }
  }

  /** Debounced refresh after a Stop hook, at least 20 s after the previous fetch. */
  onStop(): void {
    if (this.clients === 0 || this.hookTimer) return;
    const delay = Math.max(2000, this.lastFetch + HOOK_GAP_MS - Date.now());
    this.hookTimer = setTimeout(() => {
      this.hookTimer = undefined;
      void this.refresh();
    }, delay);
  }

  /** Manual refresh from the phone, at most once per 10 s (otherwise returns the cached value). */
  async refreshManual(): Promise<Accounts | null> {
    if (Date.now() - this.lastFetch < MANUAL_GAP_MS) return this.refreshing ?? this.accounts;
    return this.refresh();
  }

  /** Runs `fn` after every previously queued cswap call. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  refresh(): Promise<Accounts> {
    this.ensureNamesWatcher();
    if (this.refreshing) return this.refreshing;
    this.lastFetch = Date.now();
    this.refreshing = this.exclusive(async () => {
      const res = await runCswap(['list', '--json'], LIST_TIMEOUT_MS);
      const data = parseJson(res.stdout);
      const next =
        res.code === 0 && data && !data.error ? mapList(data) : fallback(`Не удалось получить аккаунты: ${errorText(res, data)}`);
      if (next.error) console.error(`[accounts] ${next.error}`);
      return applyNames(next);
    }).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing.then((a) => {
      this.accounts = a;
      this.hub.emit('accounts', a);
      return a;
    });
  }

  async switchTo(number: unknown): Promise<void> {
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) throw new UserError('Некорректный номер аккаунта');
    const res = await this.exclusive(() => runCswap(['switch', String(number), '--json'], SWITCH_TIMEOUT_MS));
    const data = parseJson(res.stdout);
    if (res.code !== 0 || !data || data.error) {
      void this.refresh();
      throw new UserError(`Не удалось переключиться: ${errorText(res, data)}`);
    }
    await this.refresh();
    if (!data.switched && data.reason !== 'already-active') {
      throw new UserError(`Переключение не выполнено${data.message ? `: ${data.message}` : ''}`);
    }
  }
}
