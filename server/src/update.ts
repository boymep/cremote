import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { servicesInstalled } from './service.js';
import { CREMOTE_HOME, LOGS_DIR, ROOT_DIR, getVersion, writeJsonAtomic } from './config.js';

const REGISTRY_URL = 'https://registry.npmjs.org/cremote/latest';
const CACHE_PATH = path.join(CREMOTE_HOME, 'update.json');
export const UPDATE_LOG = path.join(LOGS_DIR, 'update.log');

/** Parses "1.2.3" or "v1.2.3-beta.1" into [major, minor, patch, prerelease?]; null if not semver. */
function parseSemver(v: string): { nums: [number, number, number]; pre: string | null } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/** Returns >0 if a is newer than b, <0 if older, 0 if equal or not comparable. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const x = pa.pre.split('.');
  const y = pb.pre.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const nx = /^\d+$/.test(x[i]);
    const ny = /^\d+$/.test(y[i]);
    if (nx && ny) {
      if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
    } else if (nx !== ny) return nx ? -1 : 1;
    else if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

export interface UpdateCache {
  checkedAt: number;
  latest: string | null;
}

export function readCache(): UpdateCache | null {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (typeof c?.checkedAt === 'number') return { checkedAt: c.checkedAt, latest: typeof c.latest === 'string' ? c.latest : null };
  } catch {
    /* no cache */
  }
  return null;
}

/** Asks the npm registry for the latest version. null = no data (offline, not published, bad answer). */
export async function checkLatest(): Promise<string | null> {
  let latest: string | null = null;
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    if (res.ok) {
      const v = ((await res.json()) as { version?: unknown }).version;
      if (typeof v === 'string' && parseSemver(v)) latest = v;
    }
  } catch {
    /* offline or timeout */
  }
  // Keep the last known version when the registry is unreachable.
  if (latest === null) latest = readCache()?.latest ?? null;
  try {
    fs.mkdirSync(CREMOTE_HOME, { recursive: true, mode: 0o700 });
    writeJsonAtomic(CACHE_PATH, { checkedAt: Date.now(), latest } satisfies UpdateCache, 0o600);
  } catch {
    /* cache is best effort */
  }
  return latest;
}

export type InstallKind = 'global' | 'git' | 'unknown';

/** Pure: decides how this copy of cremote was installed. */
export function detectInstallKind(root: string, globalRoot: string | null, hasGit: boolean): InstallKind {
  if (hasGit) return 'git';
  if (globalRoot) {
    const rel = path.relative(globalRoot, root);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return 'global';
  }
  return 'unknown';
}

function npmPath(): string {
  return path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
}

function globalNpmRoot(): string | null {
  try {
    const npm = npmPath();
    if (!fs.existsSync(npm)) return null;
    return fs.realpathSync(execFileSync(npm, ['root', '-g'], { encoding: 'utf8', timeout: 15_000 }).trim());
  } catch {
    return null;
  }
}

export function installKind(): InstallKind {
  let root = ROOT_DIR;
  try {
    root = fs.realpathSync(ROOT_DIR);
  } catch {
    /* keep */
  }
  return detectInstallKind(root, globalNpmRoot(), fs.existsSync(path.join(ROOT_DIR, '.git')));
}

export const GIT_HINT = 'Обновите через git pull && npm ci && npm run build';
export const UNKNOWN_HINT = 'Не удалось определить способ установки. Обновите вручную: npm i -g cremote@latest';

/** Can the UI/`cremote update` update this install automatically? */
export function canUpdate(): boolean {
  return installKind() === 'global';
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  available: boolean;
}

export function statusFrom(latest: string | null): UpdateStatus {
  const current = getVersion();
  return { current, latest, available: latest !== null && compareSemver(latest, current) > 0 };
}

function log(line: string): void {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(UPDATE_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* ignore */
  }
}

function run(cmd: string, args: string[]): void {
  log(`$ ${cmd} ${args.join(' ')}`);
  const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60_000 });
  if (out.trim()) log(out.trim());
}

/** Installs `latest` globally, re-installs hooks with the new package and restarts services. */
export function runUpdate(latest: string): void {
  const kind = installKind();
  if (kind === 'git') throw new Error(GIT_HINT);
  if (kind === 'unknown') throw new Error(UNKNOWN_HINT);
  const globalRoot = globalNpmRoot();
  if (!globalRoot) throw new Error(UNKNOWN_HINT);
  log(`update ${getVersion()} -> ${latest}`);
  try {
    run(npmPath(), ['i', '-g', `cremote@${latest}`]);
    const newBin = path.join(globalRoot, 'cremote', 'dist', 'server', 'cli.js');
    if (!fs.existsSync(newBin)) throw new Error(`Не найден ${newBin} после установки`);
    run(process.execPath, [newBin, 'hooks', 'install']);
    // Regenerates plist/unit with the current node and package paths and reloads (restarts) them.
    if (servicesInstalled()) run(process.execPath, [newBin, 'service', 'install']);
    log('update done');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`update failed: ${msg}`);
    throw new Error(`Обновление не удалось: ${msg.split('\n')[0]}. Подробности: ${UPDATE_LOG}`);
  }
}

/** Starts `cremote update -y` detached, so a service restart cannot kill it. */
export function spawnDetachedUpdate(): void {
  fs.mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(UPDATE_LOG, 'a');
  const cli = path.join(ROOT_DIR, 'dist', 'server', 'cli.js');
  const child = spawn(process.execPath, [cli, 'update', '-y'], { detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  fs.closeSync(fd);
}

export interface UpdateInfo extends UpdateStatus {
  canUpdate: boolean;
  autoUpdate: 'notify' | 'auto' | 'off';
}

const DAY_MS = 24 * 3600_000;

/** Periodic registry check. Calls onChange when the visible state changes. */
export class UpdateWatcher {
  private latest: string | null = readCache()?.latest ?? null;
  private can: boolean | null = null;
  private timer: NodeJS.Timeout | null = null;
  private autoTriedFor: string | null = null;

  constructor(
    private getAuto: () => 'notify' | 'auto' | 'off',
    private busy: () => boolean,
    private onChange: (info: UpdateInfo) => void,
  ) {}

  info(): UpdateInfo {
    this.can ??= canUpdate();
    return { ...statusFrom(this.latest), canUpdate: this.can, autoUpdate: this.getAuto() };
  }

  start(): void {
    const cached = readCache();
    const stale = !cached || Date.now() - cached.checkedAt > DAY_MS;
    if (stale) void this.refresh();
    this.timer = setInterval(() => void this.refresh(), DAY_MS);
    this.timer.unref();
    const tick = setInterval(() => this.maybeAuto(), 10 * 60_000);
    tick.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    const before = this.latest;
    this.latest = await checkLatest();
    if (this.latest !== before) this.onChange(this.info());
    this.maybeAuto();
  }

  private maybeAuto(now = new Date()): void {
    if (this.getAuto() !== 'auto') return;
    const h = now.getHours();
    if (h < 3 || h >= 5) return;
    const info = this.info();
    if (!info.available || !info.canUpdate || !info.latest || this.autoTriedFor === info.latest || this.busy()) return;
    this.autoTriedFor = info.latest;
    log(`auto update to ${info.latest}`);
    try {
      spawnDetachedUpdate();
    } catch (e) {
      log(`auto update spawn failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/** CLI: `cremote update [--check] [-y]`. */
export async function updateCommand(args: string[]): Promise<void> {
  const check = args.includes('--check');
  const yes = args.includes('-y') || args.includes('--yes');
  const latest = await checkLatest();
  const st = statusFrom(latest);
  const kind = installKind();
  console.log(`Установлена версия: ${st.current}`);
  console.log(latest ? `Последняя версия: ${latest}` : 'Последняя версия: нет данных (пакет не опубликован или реестр недоступен)');
  if (kind === 'git') console.log('Установка: git-копия');
  if (!st.available) {
    if (latest) console.log('Обновлений нет.');
    return;
  }
  console.log(`Доступна новая версия ${latest}.`);
  if (check) return;
  if (kind === 'git') {
    console.error(GIT_HINT);
    process.exitCode = 1;
    return;
  }
  if (kind === 'unknown') {
    console.error(UNKNOWN_HINT);
    process.exitCode = 1;
    return;
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error('Нет терминала для подтверждения. Запустите с -y.');
      process.exitCode = 1;
      return;
    }
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question(`Обновить до ${latest}? Сервер перезапустится. [y/N] `)).trim().toLowerCase();
    rl.close();
    if (a !== 'y' && a !== 'yes' && a !== 'д' && a !== 'да') return;
  }
  runUpdate(latest!);
  console.log(`Обновлено до ${latest}. Хуки переустановлены, сервисы переустановлены и перезапущены.`);
}
