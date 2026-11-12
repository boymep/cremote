import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type { Hub } from './hub.js';

const SCAN_MS = 5000;
const MAX_PARENT_HOPS = 6;
const ID_RE = '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})';
const ARGV_ID = new RegExp(`--(?:resume|session-id)(?:=|\\s+)${ID_RE}`);
/** Native binary (VS Code extension, standalone install) or `claude` on PATH. */
const NATIVE_RE = /^(?:\S*\/)?claude(?:\s|$)/;
/** npm install: `node …/bin/claude` or `node …/@anthropic-ai/claude-code/cli.js`. */
const NODE_RE = /^\S*\bnode\s+\S*(?:\/claude|@anthropic-ai\/claude-code\/cli\.m?js)(?:\s|$)/;
const LIVE_STATUSES = new Set(['live', 'working', 'idle', 'awaiting_input']);

interface Proc {
  pid: number;
  ppid: number;
  start: number;
  command: string;
}

export interface OpenInfo {
  pid: number;
  since: number;
  via: 'hook' | 'argv' | 'guess';
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 8 * 1024 * 1024, timeout: 5000 }, (_e, out) =>
      resolve(String(out ?? '')),
    );
  });
}

function parsePs(out: string): Map<number, Proc> {
  const table = new Map<number, Proc>();
  // "  PID  PPID Wed Oct 28 13:58:38 2026 command…"
  const re = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/;
  for (const line of out.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const start = new Date(m[3]).getTime();
    table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), start: Number.isNaN(start) ? 0 : start, command: m[4] });
  }
  return table;
}

export function isClaudeCommand(cmd: string): boolean {
  return NATIVE_RE.test(cmd) || NODE_RE.test(cmd);
}

/**
 * Detects which sessions have a running Claude Code process (VS Code tab or CLI).
 * Mapping priority: hook event from the process > `--resume/--session-id` in argv > cwd guess.
 */
export class ProcessTracker {
  private table = new Map<number, Proc>();
  private claude = new Map<number, Proc>();
  /** pid -> session reported by the latest hook from that process (start time guards pid reuse). */
  private hookMap = new Map<number, { sessionId: string; start: number }>();
  private cwdCache = new Map<string, string>();
  private open = new Map<string, OpenInfo>();
  /** cwds that have a Claude process we could not attribute to a session. */
  private unmappedCwds = new Set<string>();
  /** Sessions that were seen open, or restored from state.json: they get 'ended' once their process is gone. */
  private watchEnd = new Set<string>();
  private scanning?: Promise<void>;
  private timer?: NodeJS.Timeout;
  scannedOnce = false;
  stats = { open: 0, argv: 0, hook: 0, guess: 0, unmapped: 0 };

  constructor(private hub: Hub) {
    for (const [id, l] of hub.live) if (LIVE_STATUSES.has(l.status)) this.watchEnd.add(id);
  }

  setClients(n: number): void {
    if (n > 0 && !this.timer) {
      this.timer = setInterval(() => void this.scan(), SCAN_MS);
      void this.scan();
    } else if (n === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }

  openSessions(): Map<string, OpenInfo> {
    return this.open;
  }

  info(sessionId: string): OpenInfo | undefined {
    return this.open.get(sessionId);
  }

  /** True when an unattributed Claude process runs in this cwd, so "not open" is not trustworthy. */
  uncertain(cwd: string | undefined): boolean {
    return !!cwd && this.unmappedCwds.has(cwd);
  }

  /** Called from the hook handler with the hook script's parent pid. */
  async noteHook(sessionId: string, ppid: number | undefined, event: string): Promise<void> {
    if (ppid && ppid > 1) {
      let pid = this.findClaudeAncestor(ppid);
      if (pid === undefined) {
        await this.scan(true);
        pid = this.findClaudeAncestor(ppid);
      }
      if (pid !== undefined) {
        const proc = this.table.get(pid)!;
        if (event === 'SessionEnd') {
          if (this.hookMap.get(pid)?.sessionId === sessionId) this.hookMap.delete(pid);
        } else {
          this.hookMap.set(pid, { sessionId, start: proc.start });
        }
      }
    }
    await this.scan(true);
  }

  private findClaudeAncestor(pid: number): number | undefined {
    let cur: number | undefined = pid;
    for (let i = 0; i < MAX_PARENT_HOPS && cur && cur > 1; i++) {
      const p = this.table.get(cur);
      if (!p) return undefined;
      if (this.claude.has(cur)) return cur;
      cur = p.ppid;
    }
    return undefined;
  }

  private async cwdOf(p: Proc): Promise<string | undefined> {
    const key = `${p.pid}:${p.start}`;
    const cached = this.cwdCache.get(key);
    if (cached !== undefined) return cached || undefined;
    let cwd = '';
    if (process.platform === 'linux') {
      try {
        cwd = fs.readlinkSync(`/proc/${p.pid}/cwd`);
      } catch {
        /* no access or process gone: fall back to lsof */
      }
    }
    if (!cwd) {
      const out = await run('lsof', ['-a', '-p', String(p.pid), '-d', 'cwd', '-Fn']);
      const line = out.split('\n').find((l) => l.startsWith('n'));
      cwd = line ? line.slice(1) : '';
    }
    this.cwdCache.set(key, cwd);
    return cwd || undefined;
  }

  /** One `ps` call; `lsof` only for unattributed processes (cached per pid). */
  scan(force = false): Promise<void> {
    if (this.scanning && !force) return this.scanning;
    const job: Promise<void> = (this.scanning ?? Promise.resolve())
      .then(() => this.doScan())
      .finally(() => {
        if (this.scanning === job) this.scanning = undefined;
      });
    this.scanning = job;
    return job;
  }

  private async doScan(): Promise<void> {
    this.table = parsePs(await run('ps', process.platform === 'linux' ? ['-eo', 'pid=,ppid=,lstart=,args='] : ['-axo', 'pid=,ppid=,lstart=,command=']));
    this.claude = new Map();
    for (const p of this.table.values()) {
      // cremote's own SDK children are tracked by SdkManager.
      if (p.ppid === process.pid) continue;
      if (isClaudeCommand(p.command)) this.claude.set(p.pid, p);
    }
    for (const [pid, h] of this.hookMap) {
      if (this.claude.get(pid)?.start !== h.start) this.hookMap.delete(pid);
    }
    for (const key of this.cwdCache.keys()) {
      const [pid, start] = key.split(':').map(Number);
      if (this.table.get(pid)?.start !== start) this.cwdCache.delete(key);
    }

    const open = new Map<string, OpenInfo>();
    const claim = (sessionId: string, info: OpenInfo) => {
      const prev = open.get(sessionId);
      // Two processes on one session: prefer hook evidence, then the newer process.
      const rank = { hook: 2, argv: 1, guess: 0 };
      if (!prev || rank[info.via] > rank[prev.via] || (rank[info.via] === rank[prev.via] && info.since > prev.since)) {
        open.set(sessionId, info);
      }
    };
    const unmapped: Proc[] = [];
    for (const p of this.claude.values()) {
      const hook = this.hookMap.get(p.pid);
      if (hook) {
        claim(hook.sessionId, { pid: p.pid, since: p.start, via: 'hook' });
        continue;
      }
      const m = ARGV_ID.exec(p.command);
      if (m) claim(m[1], { pid: p.pid, since: p.start, via: 'argv' });
      else unmapped.push(p);
    }

    // Guess: newest transcript in the same cwd modified after the process started, only when unambiguous.
    const unmappedCwds = new Set<string>();
    const candidates = new Map<number, string[]>();
    const transcripts = this.hub.transcripts.list();
    for (const p of unmapped) {
      const cwd = await this.cwdOf(p);
      if (!cwd) continue;
      const list = transcripts.filter((t) => t.cwd === cwd && t.mtime >= p.start && !open.has(t.id)).map((t) => t.id);
      candidates.set(p.pid, list);
      unmappedCwds.add(cwd);
    }
    const claimedBy = new Map<string, number>();
    for (const list of candidates.values()) for (const id of list) claimedBy.set(id, (claimedBy.get(id) ?? 0) + 1);
    for (const [pid, list] of candidates) {
      if (list.length === 1 && claimedBy.get(list[0]) === 1) {
        claim(list[0], { pid, since: this.claude.get(pid)!.start, via: 'guess' });
      }
    }
    // A cwd stays "uncertain" only if it still has a process we could not attribute.
    const guessedPids = new Set([...open.values()].filter((o) => o.via === 'guess').map((o) => o.pid));
    this.unmappedCwds = new Set();
    for (const p of unmapped) {
      if (guessedPids.has(p.pid)) continue;
      const cwd = this.cwdCache.get(`${p.pid}:${p.start}`);
      if (cwd) this.unmappedCwds.add(cwd);
    }

    const changed =
      open.size !== this.open.size ||
      [...open].some(([id, o]) => {
        const prev = this.open.get(id);
        return !prev || prev.pid !== o.pid || prev.via !== o.via;
      });
    this.open = open;
    for (const id of open.keys()) this.watchEnd.add(id);
    this.stats = {
      open: open.size,
      argv: [...open.values()].filter((o) => o.via === 'argv').length,
      hook: [...open.values()].filter((o) => o.via === 'hook').length,
      guess: [...open.values()].filter((o) => o.via === 'guess').length,
      unmapped: unmapped.length - guessedPids.size,
    };

    // Process gone: the session cannot be live any more.
    for (const id of [...this.watchEnd]) {
      if (open.has(id)) continue;
      const live = this.hub.live.get(id);
      const cwd = live?.cwd ?? this.hub.transcripts.get(id)?.cwd;
      if (this.uncertain(cwd)) continue;
      this.watchEnd.delete(id);
      if (live && LIVE_STATUSES.has(live.status) && !live.waker) {
        this.hub.setLive(id, { status: 'ended', interruptRequested: false });
      }
    }
    this.scannedOnce = true;
    if (changed) {
      const st = this.stats;
      console.log(`[processes] open ${st.open} (hook ${st.hook}, argv ${st.argv}, guess ${st.guess}), unattributed processes ${st.unmapped}`);
      this.hub.sessionsChanged();
    }
  }
}
