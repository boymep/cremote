import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findBinary } from './service.js';
import type { AccessConfig } from './config.js';

export const MIN_NODE_MAJOR = 20;

export function nodeOk(): boolean {
  return Number(process.versions.node.split('.')[0]) >= MIN_NODE_MAJOR;
}

function isExec(f: string): boolean {
  try {
    fs.accessSync(f, fs.constants.X_OK);
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
}

/** Finds the `claude` CLI on PATH and in the usual install places (native, local, nvm). */
export function findClaude(): string | null {
  const home = os.homedir();
  const fixed = [path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'];
  const onPath = findBinary('claude');
  if (onPath) return onPath;
  for (const f of fixed) if (isExec(f)) return f;
  const nvm = path.join(process.env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node');
  try {
    for (const v of fs.readdirSync(nvm).sort().reverse()) {
      const f = path.join(nvm, v, 'bin', 'claude');
      if (isExec(f)) return f;
    }
  } catch {
    /* no nvm */
  }
  return null;
}

/** Presence check only: looks for the oauthAccount key / credentials file, never reads token values. */
export function claudeLoggedIn(): boolean {
  const dirs = [path.join(os.homedir(), '.claude')];
  if (process.env.CLAUDE_CONFIG_DIR) dirs.push(path.resolve(process.env.CLAUDE_CONFIG_DIR));
  const jsons = [path.join(os.homedir(), '.claude.json'), ...dirs.map((d) => path.join(d, '.claude.json'))];
  for (const f of jsons) {
    try {
      if (JSON.parse(fs.readFileSync(f, 'utf8'))?.oauthAccount) return true;
    } catch {
      /* next */
    }
  }
  return dirs.some((d) => fs.existsSync(path.join(d, '.credentials.json')));
}

export function findTailscale(): string | null {
  const mac = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  return findBinary('tailscale') ?? (isExec(mac) ? mac : null);
}

/** MagicDNS name of this machine, without trailing dot; null if tailscale is down or logged out. */
export function tailscaleDnsName(bin: string): string | null {
  const r = spawnSync(bin, ['status', '--json'], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) return null;
  try {
    const name = JSON.parse(r.stdout)?.Self?.DNSName;
    return typeof name === 'string' && name ? name.replace(/\.$/, '') : null;
  } catch {
    return null;
  }
}

export function sshArgs(target: string, identityFile?: string): string[] {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...(identityFile ? ['-i', identityFile] : []), target, 'true'];
}

/** Non-interactive ssh login test. */
export function testSsh(target: string, identityFile?: string): { ok: boolean; error: string } {
  const r = spawnSync('ssh', sshArgs(target, identityFile), { encoding: 'utf8', timeout: 20_000 });
  if (r.error) return { ok: false, error: r.error.message };
  return { ok: r.status === 0, error: (r.stderr || '').trim().split('\n').pop() ?? '' };
}

export const SSH_HINT =
  'Проверьте адрес и порт, что ключ добавлен на сервер (ssh-copy-id user@host) и что вход проходит без пароля и вопросов. Для ключа не из ~/.ssh укажите файл ключа.';

export function accessUrl(access: AccessConfig, port: number | string, tsName?: string | null): string {
  switch (access.mode) {
    case 'tailscale':
      return tsName ? `https://${tsName}` : '(адрес появится после «tailscale serve», см. «tailscale status»)';
    case 'cloudflare':
      return access.publicUrl || '(публичный адрес задан в панели Cloudflare Zero Trust)';
    case 'ssh':
      return access.publicUrl || `(на сервере ${access.ssh?.target ?? ''} порт 127.0.0.1:${access.ssh?.remotePort ?? ''}; опубликуйте его через nginx/caddy)`;
    default:
      return `http://127.0.0.1:${port}`;
  }
}
