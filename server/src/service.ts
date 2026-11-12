import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { CREMOTE_HOME, LOGS_DIR, ROOT_DIR, getAccess, readConfig, type AccessConfig } from './config.js';

export const SERVER_LABEL = 'dev.cremote.server';
export const TUNNEL_LABEL = 'dev.cremote.tunnel';

export type ServicePlatform = 'darwin' | 'linux';
export const SERVER_UNIT = 'cremote.service';
export const TUNNEL_UNIT = 'cremote-tunnel.service';

export interface TunnelJob {
  args: string[];
  /** Environment of the job. May hold secrets (cloudflare token): the file that carries it must be mode 600. */
  env: Record<string, string>;
}

export function currentPlatform(): ServicePlatform {
  if (process.platform === 'darwin' || process.platform === 'linux') return process.platform;
  throw new Error(`Сервисы не поддерживаются на ${process.platform}. Запускайте «cremote start» вручную.`);
}

/** Absolute path of a binary found on PATH or in common install dirs; null if missing. */
export function findBinary(name: string): string | null {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', path.join(os.homedir(), '.local', 'bin')];
  for (const d of dirs) {
    if (!d) continue;
    const f = path.join(d, name);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      return f;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Builds the tunnel job for the access mode, or null if the mode needs no tunnel job (tailscale, none). */
export function tunnelJob(access: AccessConfig, port: string, cloudflaredPath: string = 'cloudflared'): TunnelJob | null {
  if (access.mode === 'ssh' && access.ssh?.target) {
    const { target, remotePort, identityFile } = access.ssh;
    return {
      args: [
        '/usr/bin/ssh',
        '-N',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ExitOnForwardFailure=yes',
        '-R', `127.0.0.1:${remotePort}:127.0.0.1:${port}`,
        ...(identityFile ? ['-i', identityFile] : []),
        target,
      ],
      env: {},
    };
  }
  if (access.mode === 'cloudflare' && access.cloudflare?.token) {
    // cloudflared reads the token from TUNNEL_TOKEN; keeping it out of argv hides it from `ps`.
    return { args: [cloudflaredPath, 'tunnel', '--no-autoupdate', 'run'], env: { TUNNEL_TOKEN: access.cloudflare.token } };
  }
  return null;
}

function agentsDir(): string {
  return process.env.CREMOTE_LAUNCH_AGENTS || path.join(os.homedir(), 'Library', 'LaunchAgents');
}

function systemdDir(): string {
  return process.env.CREMOTE_SYSTEMD_DIR || path.join(os.homedir(), '.config', 'systemd', 'user');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildPlist(label: string, args: string[], env: Record<string, string>, log: string): string {
  const envXml = Object.entries(env)
    .map(([k, v]) => `      <key>${esc(k)}</key>\n      <string>${esc(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${esc(label)}</string>
    <key>ProgramArguments</key>
    <array>
${args.map((a) => `      <string>${esc(a)}</string>`).join('\n')}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${esc(log)}</string>
    <key>StandardErrorPath</key>
    <string>${esc(log)}</string>
  </dict>
</plist>
`;
}

const sdQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\])/g, '\\$1').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`);

/** systemd --user unit text. Secrets go to `envFile` (mode 600), never into the unit. */
export function buildSystemdUnit(o: { description: string; args: string[]; env: Record<string, string>; envFile?: string; log: string; after?: string }): string {
  const lines = [
    '[Unit]',
    `Description=${o.description}`,
    `After=${o.after ?? 'network-online.target'}`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${o.args.map(sdQuote).join(' ')}`,
    ...Object.entries(o.env).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`),
    ...(o.envFile ? [`EnvironmentFile=${o.envFile}`] : []),
    'Restart=always',
    'RestartSec=10',
    `StandardOutput=append:${o.log}`,
    `StandardError=append:${o.log}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ];
  return lines.join('\n');
}

export interface ServiceFile {
  /** launchd label or systemd unit name */
  name: string;
  file: string;
  body: string;
  mode: number;
  /** extra secret file (systemd EnvironmentFile) */
  secret?: { file: string; body: string };
}

export interface ServiceContext {
  platform: ServicePlatform;
  access: AccessConfig;
  port: string;
  nodePath: string;
  cliPath: string;
  logsDir: string;
  home: string;
  /** extra env for the server job */
  serverEnv: Record<string, string>;
  cloudflaredPath?: string;
}

/** Pure: files for the server job and (if the mode needs one) the tunnel job. */
export function buildServiceFiles(c: ServiceContext): { files: ServiceFile[]; tunnelNeeded: boolean } {
  const job = tunnelJob(c.access, c.port, c.cloudflaredPath);
  const files: ServiceFile[] = [];
  if (c.platform === 'darwin') {
    const dir = agentsDir();
    const serverEnv = {
      PATH: `${path.dirname(c.nodePath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: c.home,
      ...c.serverEnv,
    };
    files.push({
      name: SERVER_LABEL,
      file: path.join(dir, `${SERVER_LABEL}.plist`),
      body: buildPlist(SERVER_LABEL, [c.nodePath, c.cliPath, 'start'], serverEnv, path.join(c.logsDir, 'server.log')),
      mode: 0o600,
    });
    if (job) {
      files.push({
        name: TUNNEL_LABEL,
        file: path.join(dir, `${TUNNEL_LABEL}.plist`),
        body: buildPlist(TUNNEL_LABEL, job.args, { PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: c.home, ...job.env }, path.join(c.logsDir, 'tunnel.log')),
        mode: 0o600,
      });
    }
  } else {
    const dir = systemdDir();
    const serverEnv = { PATH: `${path.dirname(c.nodePath)}:/usr/local/bin:/usr/bin:/bin:${c.home}/.local/bin`, ...c.serverEnv };
    files.push({
      name: SERVER_UNIT,
      file: path.join(dir, SERVER_UNIT),
      body: buildSystemdUnit({ description: 'cremote server', args: [c.nodePath, c.cliPath, 'start'], env: serverEnv, log: path.join(c.logsDir, 'server.log') }),
      mode: 0o644,
    });
    if (job) {
      const secretEnv = Object.entries(job.env);
      const envFile = path.join(path.dirname(c.logsDir), 'tunnel.env');
      files.push({
        name: TUNNEL_UNIT,
        file: path.join(dir, TUNNEL_UNIT),
        body: buildSystemdUnit({
          description: 'cremote tunnel',
          args: job.args,
          env: {},
          envFile: secretEnv.length ? envFile : undefined,
          log: path.join(c.logsDir, 'tunnel.log'),
        }),
        mode: 0o644,
        secret: secretEnv.length ? { file: envFile, body: secretEnv.map(([k, v]) => `${k}=${v}`).join('\n') + '\n' } : undefined,
      });
    }
  }
  return { files, tunnelNeeded: !!job };
}

function launchctl(args: string[]): void {
  try {
    execFileSync('launchctl', args, { stdio: 'ignore' });
  } catch {
    /* bootout of a missing job fails; that's fine */
  }
}

function systemctl(args: string[], strict = false): string {
  const r = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
  if (r.error) throw new Error(`systemctl не найден: ${r.error.message}`);
  if (strict && r.status !== 0) throw new Error(`systemctl --user ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  return (r.stdout ?? '').trim();
}

function writePrivate(file: string, body: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode });
  fs.chmodSync(file, mode);
}

export function serviceContext(platform: ServicePlatform = currentPlatform()): ServiceContext {
  const serverEnv: Record<string, string> = {};
  if (process.env.CREMOTE_HOME) serverEnv.CREMOTE_HOME = CREMOTE_HOME;
  for (const k of ['CREMOTE_PORT', 'CREMOTE_HOST', 'CLAUDE_CONFIG_DIR']) if (process.env[k]) serverEnv[k] = process.env[k]!;
  const cfg = readConfig();
  return {
    platform,
    access: getAccess(cfg),
    port: String(Number(process.env.CREMOTE_PORT) || cfg?.port || 7878),
    nodePath: process.execPath,
    cliPath: path.join(ROOT_DIR, 'dist', 'server', 'cli.js'),
    logsDir: LOGS_DIR,
    home: os.homedir(),
    serverEnv,
    cloudflaredPath: findBinary('cloudflared') ?? undefined,
  };
}

export interface InstallResult {
  files: string[];
  hints: string[];
}

export function serviceInstall(load = true): InstallResult {
  const platform = currentPlatform();
  const ctx = serviceContext(platform);
  if (ctx.access.mode === 'cloudflare' && !ctx.cloudflaredPath) {
    throw new Error('cloudflared не найден в PATH. Установите его: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
  }
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const { files, tunnelNeeded } = buildServiceFiles(ctx);
  const hints: string[] = [];
  const written: string[] = [];
  if (platform === 'darwin') {
    const uid = process.getuid?.() ?? 501;
    if (!tunnelNeeded) {
      const stale = path.join(agentsDir(), `${TUNNEL_LABEL}.plist`);
      if (load) launchctl(['bootout', `gui/${uid}/${TUNNEL_LABEL}`]);
      if (fs.existsSync(stale)) fs.unlinkSync(stale);
    }
    for (const f of files) {
      if (load) launchctl(['bootout', `gui/${uid}/${f.name}`]);
      writePrivate(f.file, f.body, f.mode);
      if (load) launchctl(['bootstrap', `gui/${uid}`, f.file]);
      written.push(f.file);
    }
  } else {
    if (!tunnelNeeded) {
      const stale = path.join(systemdDir(), TUNNEL_UNIT);
      if (load && fs.existsSync(stale)) systemctl(['disable', '--now', TUNNEL_UNIT]);
      if (fs.existsSync(stale)) fs.unlinkSync(stale);
    }
    for (const f of files) {
      writePrivate(f.file, f.body, f.mode);
      if (f.secret) writePrivate(f.secret.file, f.secret.body, 0o600);
      written.push(f.file);
    }
    if (load) {
      systemctl(['daemon-reload'], true);
      for (const f of files) systemctl(['enable', '--now', f.name], true);
      // restart so that a changed unit/config is picked up on re-run
      for (const f of files) systemctl(['restart', f.name]);
    }
    hints.push(`Чтобы сервисы работали без входа в систему, выполните: loginctl enable-linger ${os.userInfo().username}`);
  }
  return { files: written, hints };
}

export function serviceUninstall(load = true): string[] {
  const platform = currentPlatform();
  const removed: string[] = [];
  if (platform === 'darwin') {
    const dir = agentsDir();
    const uid = process.getuid?.() ?? 501;
    for (const label of [SERVER_LABEL, TUNNEL_LABEL]) {
      if (load) launchctl(['bootout', `gui/${uid}/${label}`]);
      const file = path.join(dir, `${label}.plist`);
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        removed.push(file);
      }
    }
  } else {
    const dir = systemdDir();
    for (const unit of [SERVER_UNIT, TUNNEL_UNIT]) {
      const file = path.join(dir, unit);
      if (load && fs.existsSync(file)) systemctl(['disable', '--now', unit]);
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        removed.push(file);
      }
    }
    const envFile = path.join(CREMOTE_HOME, 'tunnel.env');
    if (fs.existsSync(envFile)) {
      fs.unlinkSync(envFile);
      removed.push(envFile);
    }
    if (load) systemctl(['daemon-reload']);
  }
  return removed;
}

/** True if the server service file exists (launchd plist or systemd unit). */
export function servicesInstalled(): boolean {
  return fs.existsSync(path.join(currentPlatform() === 'darwin' ? agentsDir() : systemdDir(), currentPlatform() === 'darwin' ? `${SERVER_LABEL}.plist` : SERVER_UNIT));
}

export function serviceRestart(): string[] {
  const platform = currentPlatform();
  const done: string[] = [];
  if (platform === 'darwin') {
    const uid = process.getuid?.() ?? 501;
    for (const label of [SERVER_LABEL, TUNNEL_LABEL]) {
      if (!fs.existsSync(path.join(agentsDir(), `${label}.plist`))) continue;
      execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], { stdio: 'ignore' });
      done.push(label);
    }
  } else {
    for (const unit of [SERVER_UNIT, TUNNEL_UNIT]) {
      if (!fs.existsSync(path.join(systemdDir(), unit))) continue;
      systemctl(['restart', unit], true);
      done.push(unit);
    }
  }
  return done;
}

export interface JobStatus {
  name: string;
  installed: boolean;
  running: boolean;
  detail: string;
}

export function serviceStatus(): JobStatus[] {
  const platform = currentPlatform();
  const out: JobStatus[] = [];
  if (platform === 'darwin') {
    const uid = process.getuid?.() ?? 501;
    for (const label of [SERVER_LABEL, TUNNEL_LABEL]) {
      const installed = fs.existsSync(path.join(agentsDir(), `${label}.plist`));
      if (!installed) {
        out.push({ name: label, installed: false, running: false, detail: 'не установлен' });
        continue;
      }
      const r = spawnSync('launchctl', ['print', `gui/${uid}/${label}`], { encoding: 'utf8' });
      const state = /\bstate = (\w+)/.exec(r.stdout ?? '')?.[1];
      const pid = /\bpid = (\d+)/.exec(r.stdout ?? '')?.[1];
      const running = r.status === 0 && state === 'running';
      out.push({ name: label, installed, running, detail: r.status !== 0 ? 'не загружен' : running ? `работает${pid ? `, pid ${pid}` : ''}` : (state ?? 'остановлен') });
    }
  } else {
    for (const unit of [SERVER_UNIT, TUNNEL_UNIT]) {
      const installed = fs.existsSync(path.join(systemdDir(), unit));
      if (!installed) {
        out.push({ name: unit, installed: false, running: false, detail: 'не установлен' });
        continue;
      }
      const active = systemctl(['is-active', unit]);
      out.push({ name: unit, installed, running: active === 'active', detail: active === 'active' ? 'работает' : active || 'остановлен' });
    }
  }
  return out;
}
