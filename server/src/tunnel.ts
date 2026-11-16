import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { getAccess, readConfig, type AccessConfig, type Config } from './config.js';
import { sshArgs } from './checks.js';
import { TUNNEL_LABEL, TUNNEL_UNIT, currentPlatform, tunnelRestart } from './service.js';

/** Random id of this server process. /api/health returns it, so a probe can tell it reached THIS server. */
export const INSTANCE_ID = crypto.randomUUID();

export const WATCHDOG_INTERVAL_MS = 60_000;
/** A tick this much later than expected means the machine slept. */
export const WAKE_GAP_MS = 150_000;
export const FAILURES_BEFORE_RESTART = 3;
export const FAILURES_BEFORE_RESTART_AFTER_WAKE = 1;
export const MIN_RESTART_GAP_MS = 2 * 60_000;
export const MAX_RESTART_GAP_MS = 10 * 60_000;
export const PROBE_TIMEOUT_MS = 10_000;

export interface WatchdogState {
  failures: number;
  lastTickAt: number | null;
  lastRestartAt: number | null;
  /** Minimum gap before the next restart. Doubles after each restart, resets after a successful probe. */
  backoffMs: number;
}
export type WatchdogAction = 'none' | 'restart' | 'wait';

export function initialWatchdogState(): WatchdogState {
  return { failures: 0, lastTickAt: null, lastRestartAt: null, backoffMs: MIN_RESTART_GAP_MS };
}

export function isWake(state: WatchdogState, now: number): boolean {
  return state.lastTickAt !== null && now - state.lastTickAt > WAKE_GAP_MS;
}

/** Pure decision step: takes the probe result, returns the next state and what to do. */
export function watchdogStep(state: WatchdogState, probe: { now: number; ok: boolean }): { state: WatchdogState; action: WatchdogAction; wake: boolean } {
  const wake = isWake(state, probe.now);
  const next: WatchdogState = { ...state, lastTickAt: probe.now };
  if (probe.ok) return { state: { ...next, failures: 0, backoffMs: MIN_RESTART_GAP_MS }, action: 'none', wake };
  next.failures = state.failures + 1;
  const threshold = wake ? FAILURES_BEFORE_RESTART_AFTER_WAKE : FAILURES_BEFORE_RESTART;
  if (next.failures < threshold) return { state: next, action: 'none', wake };
  if (state.lastRestartAt !== null && probe.now - state.lastRestartAt < state.backoffMs) return { state: next, action: 'wait', wake };
  return {
    state: { ...next, failures: 0, lastRestartAt: probe.now, backoffMs: Math.min(state.backoffMs * 2, MAX_RESTART_GAP_MS) },
    action: 'restart',
    wake,
  };
}

export interface ProbeResult {
  ok: boolean;
  error?: string;
  via: 'public' | 'ssh';
}

function parseHealth(body: string, expected: string | undefined): { ok: boolean; error?: string } {
  let j: { ok?: boolean; instance?: string };
  try {
    j = JSON.parse(body);
  } catch {
    return { ok: false, error: 'неожиданный ответ (не JSON)' };
  }
  if (!j.ok) return { ok: false, error: 'ответ без ok' };
  if (expected && j.instance !== expected) return { ok: false, error: 'отвечает не этот сервер (другой instance)' };
  return { ok: true };
}

/** Checks that `GET /api/health` through the tunnel reaches this very server. Only for ssh mode. */
export async function probeTunnel(access: AccessConfig, instance?: string): Promise<ProbeResult> {
  if (access.publicUrl) {
    const base = /^https?:\/\//.test(access.publicUrl) ? access.publicUrl : `https://${access.publicUrl}`;
    try {
      const res = await fetch(`${base.replace(/\/+$/, '')}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: 'no-store' });
      if (res.status !== 200) return { ok: false, via: 'public', error: `HTTP ${res.status}` };
      return { ...parseHealth(await res.text(), instance), via: 'public' };
    } catch (e) {
      return { ok: false, via: 'public', error: (e as Error).message };
    }
  }
  const ssh = access.ssh;
  if (!ssh?.target) return { ok: false, via: 'ssh', error: 'SSH-адрес не задан' };
  const args = sshArgs(ssh.target, ssh.identityFile).slice(0, -1);
  args.push(`curl -fsS --max-time 8 http://127.0.0.1:${ssh.remotePort}/api/health`);
  return new Promise((resolve) => {
    execFile('ssh', args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS + 10_000 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, via: 'ssh', error: (stderr || err.message).trim().split('\n').pop() || 'ошибка ssh' });
      resolve({ ...parseHealth(stdout, instance), via: 'ssh' });
    });
  });
}

export function watchdogEnabled(cfg: Config | null): boolean {
  return getAccess(cfg).mode === 'ssh' && cfg?.tunnelWatchdog !== false;
}

/** True when this process was started by the cremote launchd/systemd service. */
export function runsUnderService(): boolean {
  return process.platform === 'darwin' ? Boolean(process.env.XPC_SERVICE_NAME?.startsWith('dev.cremote.')) : Boolean(process.env.INVOCATION_ID);
}

export function tunnelRestartHint(): string {
  if (currentPlatform() === 'darwin') return `launchctl kickstart -k gui/${process.getuid?.() ?? 501}/${TUNNEL_LABEL}`;
  return `systemctl --user restart ${TUNNEL_UNIT}`;
}

/** Starts the watchdog if config and environment allow. Returns a stop function. */
export function startTunnelWatchdog(log: (msg: string) => void = (m) => console.log(m)): () => void {
  const cfg = readConfig();
  if (!watchdogEnabled(cfg) || !runsUnderService()) return () => {};
  const access = getAccess(cfg);
  let state = initialWatchdogState();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      const r = await probeTunnel(access, INSTANCE_ID);
      const step = watchdogStep(state, { now, ok: r.ok });
      state = step.state;
      if (step.wake) log(`[cremote] tunnel watchdog: обнаружен выход из сна`);
      if (!r.ok) log(`[cremote] tunnel watchdog: проверка не прошла (${r.via}): ${r.error}; подряд ${state.failures}`);
      if (step.action === 'wait') log('[cremote] tunnel watchdog: перезапуск отложен (backoff)');
      if (step.action === 'restart') {
        try {
          log(`[cremote] tunnel watchdog: перезапускаю туннель (${tunnelRestartHint()}); следующий не раньше чем через ${Math.round(state.backoffMs / 60_000)} мин`);
          tunnelRestart();
        } catch (e) {
          log(`[cremote] tunnel watchdog: не удалось перезапустить туннель: ${(e as Error).message}`);
        }
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), WATCHDOG_INTERVAL_MS);
  timer.unref();
  log(`[cremote] tunnel watchdog: включён, проверка каждые ${WATCHDOG_INTERVAL_MS / 1000} с`);
  return () => clearInterval(timer);
}
