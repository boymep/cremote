import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface Config {
  passwordHash?: string;
  hookSecret: string;
  host?: string;
  port?: number;
  /** How the phone reaches the server. */
  access?: AccessConfig;
  /** Legacy: ssh target for the reverse tunnel, e.g. "user@host". Use `access` instead. */
  tunnel?: string;
  /** Web Push VAPID subject. Default mailto:cremote@example.com */
  vapidSubject?: string;
  /** Update behaviour. Default 'notify'. */
  autoUpdate?: 'notify' | 'auto' | 'off';
  /** absolute path to the cswap CLI, if not in ~/.local/bin */
  cswapPath?: string;
  /** How long the phone counts as present after its last WS connection closed, ms. Default 30 min. */
  phonePresenceMs?: number;
  /** Extra absolute directories served by GET /api/file (besides session cwd, Downloads, etc.). */
  fileRoots?: string[];
}

export interface AccessConfig {
  mode: 'ssh' | 'tailscale' | 'cloudflare' | 'none';
  ssh?: { target: string; remotePort: number; identityFile?: string };
  cloudflare?: { token: string };
  /** Public URL, only used to print it in setup/doctor (cloudflare hostname, VPS address). */
  publicUrl?: string;
}

export const DEFAULT_VAPID_SUBJECT = 'mailto:cremote@example.com';
export const DEFAULT_REMOTE_PORT = 3010;

/** Normalized access config; maps legacy top-level `tunnel` to ssh mode. Missing config => mode 'none'. */
export function getAccess(cfg: Config | null | undefined): AccessConfig {
  if (cfg?.access?.mode) {
    const a = cfg.access;
    if (a.mode === 'ssh' && a.ssh) return { ...a, ssh: { ...a.ssh, remotePort: a.ssh.remotePort || DEFAULT_REMOTE_PORT } };
    return a;
  }
  if (cfg?.tunnel) return { mode: 'ssh', ssh: { target: cfg.tunnel, remotePort: DEFAULT_REMOTE_PORT } };
  return { mode: 'none' };
}

export function getVapidSubject(cfg: Config | null | undefined): string {
  return cfg?.vapidSubject || DEFAULT_VAPID_SUBJECT;
}

export function getAutoUpdate(cfg: Config | null | undefined): 'notify' | 'auto' | 'off' {
  const v = cfg?.autoUpdate;
  return v === 'auto' || v === 'off' ? v : 'notify';
}

export interface AuthSession {
  createdAt: number;
  expiresAt: number;
}

export interface QueuedMessage {
  id: string;
  text: string;
  /** upload ids */
  attachments: string[];
  createdAt: number;
}

export interface State {
  authSessions: Record<string, AuthSession>;
  /** Hook-reported statuses, so they survive a server restart. updatedAt = last hook event time. */
  live: Record<string, PersistedLive>;
  /** Phone messages waiting for the next Stop hook of a busy hook session. */
  queues: Record<string, QueuedMessage[]>;
  /** Web Push subscriptions by endpoint. */
  pushSubscriptions?: Record<string, PushSubscriptionRecord>;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: number;
}

export interface PersistedLive {
  status: 'live' | 'working' | 'idle' | 'awaiting_input' | 'ended';
  cwd?: string;
  updatedAt: number;
}

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HOOK_SCRIPT = path.join(ROOT_DIR, 'hooks', 'cremote-hook.mjs');
export function getVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version as string;
  } catch {
    return 'unknown';
  }
}
export const WEB_DIST = path.join(ROOT_DIR, 'web', 'dist');

export const CREMOTE_HOME = process.env.CREMOTE_HOME || path.join(os.homedir(), '.cremote');
export const CONFIG_PATH = path.join(CREMOTE_HOME, 'config.json');
export const STATE_PATH = path.join(CREMOTE_HOME, 'state.json');
export const UPLOADS_DIR = path.join(CREMOTE_HOME, 'uploads');
export const LOGS_DIR = path.join(CREMOTE_HOME, 'logs');

function earlyConfig(): Config | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config;
  } catch {
    return null;
  }
}

export const PORT = Number(process.env.CREMOTE_PORT) || earlyConfig()?.port || 7878;
export const HOST = process.env.CREMOTE_HOST || earlyConfig()?.host || '127.0.0.1';

export function claudeConfigDirs(): string[] {
  const dirs = [path.join(os.homedir(), '.claude')];
  const extra = process.env.CLAUDE_CONFIG_DIR;
  if (extra && !dirs.includes(path.resolve(extra))) dirs.push(path.resolve(extra));
  return dirs;
}

function ensureHome(): void {
  fs.mkdirSync(CREMOTE_HOME, { recursive: true, mode: 0o700 });
}

export function writeJsonAtomic(file: string, data: unknown, mode: number): void {
  ensureHome();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, mode);
}

export function readConfig(): Config | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config;
  } catch {
    return null;
  }
}

/** Returns the config, creating it (with a fresh hookSecret) if missing. */
export function ensureConfig(): Config {
  const existing = readConfig();
  if (existing?.hookSecret) return existing;
  const cfg: Config = { ...(existing ?? {}), hookSecret: crypto.randomBytes(32).toString('hex') };
  writeConfig(cfg);
  return cfg;
}

export function writeConfig(cfg: Config): void {
  writeJsonAtomic(CONFIG_PATH, cfg, 0o600);
}

export function readState(): State {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as Partial<State>;
    return { authSessions: s.authSessions ?? {}, live: s.live ?? {}, queues: s.queues ?? {}, pushSubscriptions: s.pushSubscriptions ?? {} };
  } catch {
    return { authSessions: {}, live: {}, queues: {}, pushSubscriptions: {} };
  }
}

export function writeState(state: State): void {
  writeJsonAtomic(STATE_PATH, state, 0o600);
}
