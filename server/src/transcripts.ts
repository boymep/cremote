import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { claudeConfigDirs } from './config.js';
import { normalizeEntry, promptText } from './normalize.js';
import type { Message, SessionSource } from './types.js';

const RESCAN_MS = 3000;
const CHUNK = 4 * 1024 * 1024;
const PAGE = 300;

export interface TranscriptMeta {
  id: string;
  file: string;
  cwd: string;
  title: string;
  mtime: number;
  source: SessionSource;
}

interface FileState {
  id: string;
  file: string;
  size: number;
  mtime: number;
  offset: number;
  cwd: string;
  entrypoint?: string;
  customTitle?: string;
  summaryTitle?: string;
  firstPrompt?: string;
}

interface Subscription {
  messages: Message[];
  offset: number;
  listeners: Set<(msgs: Message[]) => void>;
  reading: boolean;
  again: boolean;
}

/**
 * Reads complete lines of `file` starting at byte `start`.
 * Returns the offset right after the last complete line; a trailing partial line is left for later.
 */
async function readLines(file: string, start: number, onLine: (line: string) => void): Promise<number> {
  const fh = await fs.promises.open(file, 'r');
  try {
    let pos = start;
    let consumed = start;
    let carry: Buffer = Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      let data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let from = 0;
      for (;;) {
        const nl = data.indexOf(10, from);
        if (nl < 0) break;
        if (nl > from) onLine(data.toString('utf8', from, nl));
        from = nl + 1;
      }
      carry = Buffer.from(data.subarray(from));
      consumed = pos - carry.length;
    }
    return consumed;
  } finally {
    await fh.close();
  }
}

function tryParse(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function sourceFromEntrypoint(ep: string | undefined): SessionSource {
  if (!ep) return 'unknown';
  if (ep === 'claude-vscode') return 'vscode';
  if (ep === 'cli') return 'cli';
  if (ep.startsWith('sdk')) return 'sdk';
  return 'unknown';
}

/**
 * Indexes ~/.claude/projects/*\/*.jsonl and tails subscribed transcripts.
 * Emits 'changed' when the session index changes.
 */
export class TranscriptStore extends EventEmitter {
  private files = new Map<string, FileState>();
  private subs = new Map<string, Subscription>();
  private watchers: fs.FSWatcher[] = [];
  private fileWatchers = new Map<string, fs.FSWatcher>();
  private timer?: NodeJS.Timeout;
  private scanning = false;
  private rescanQueued = false;

  constructor(private roots: string[] = claudeConfigDirs().map((d) => path.join(d, 'projects'))) {
    super();
  }

  async start(): Promise<void> {
    await this.scan();
    for (const root of this.roots) {
      try {
        this.watchers.push(fs.watch(root, { recursive: true }, () => this.queueScan()));
      } catch {
        /* root missing; periodic rescan will pick it up */
      }
    }
    this.timer = setInterval(() => this.queueScan(), RESCAN_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    for (const w of this.watchers) w.close();
    for (const w of this.fileWatchers.values()) w.close();
  }

  list(): TranscriptMeta[] {
    return [...this.files.values()].map((f) => ({
      id: f.id,
      file: f.file,
      cwd: f.cwd,
      title: f.customTitle || f.summaryTitle || f.firstPrompt || '',
      mtime: Math.round(f.mtime),
      source: sourceFromEntrypoint(f.entrypoint),
    }));
  }

  get(id: string): TranscriptMeta | undefined {
    return this.list().find((m) => m.id === id);
  }

  /** Lets hooks register a transcript path before the periodic scan finds it. */
  noteFile(file: string | undefined): void {
    if (file && file.endsWith('.jsonl')) void this.updateFile(file).then((c) => c && this.emit('changed'));
  }

  private debounce?: NodeJS.Timeout;

  private queueScan(): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.runScan();
    }, 300);
  }

  private runScan(): void {
    if (this.scanning) {
      this.rescanQueued = true;
      return;
    }
    void this.scan();
  }

  private async scan(): Promise<void> {
    this.scanning = true;
    try {
      let changed = false;
      const seen = new Set<string>();
      for (const root of this.roots) {
        let projects: fs.Dirent[] = [];
        try {
          projects = await fs.promises.readdir(root, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const p of projects) {
          if (!p.isDirectory()) continue;
          const dir = path.join(root, p.name);
          let entries: fs.Dirent[] = [];
          try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const e of entries) {
            if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
            const file = path.join(dir, e.name);
            seen.add(file);
            if (await this.updateFile(file)) changed = true;
          }
        }
      }
      for (const [file, st] of this.files) {
        if (!seen.has(file)) {
          this.files.delete(file);
          this.subs.delete(st.id);
          changed = true;
        }
      }
      if (changed) this.emit('changed');
    } finally {
      this.scanning = false;
      if (this.rescanQueued) {
        this.rescanQueued = false;
        this.queueScan();
      }
    }
  }

  /** Incrementally updates index metadata for one file. Returns true if anything changed. */
  private async updateFile(file: string): Promise<boolean> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      return false;
    }
    let st = this.files.get(file);
    if (st && st.size === stat.size && st.mtime === stat.mtimeMs) return false;
    if (!st || stat.size < st.offset) {
      st = { id: path.basename(file, '.jsonl'), file, size: 0, mtime: 0, offset: 0, cwd: '' };
      this.files.set(file, st);
    }
    const s = st;
    try {
      s.offset = await readLines(file, s.offset, (line) => this.indexLine(s, line));
    } catch {
      return false;
    }
    s.size = stat.size;
    s.mtime = stat.mtimeMs;
    if (this.subs.has(s.id)) void this.tail(s.id);
    return true;
  }

  private indexLine(st: FileState, line: string): void {
    if (line.includes('"type":"custom-title"')) {
      const e = tryParse(line);
      if (e?.type === 'custom-title' && typeof e.customTitle === 'string') st.customTitle = e.customTitle;
      return;
    }
    if (line.includes('"type":"summary"') || line.includes('"type":"ai-title"')) {
      const e = tryParse(line);
      if (e?.type === 'summary' && typeof e.summary === 'string') st.summaryTitle = e.summary;
      if (e?.type === 'ai-title' && typeof e.aiTitle === 'string') st.summaryTitle = e.aiTitle;
      return;
    }
    const needCwd = !st.cwd && line.includes('"cwd":');
    const needEp = !st.entrypoint && line.includes('"entrypoint":');
    const needPrompt = !st.firstPrompt && line.includes('"type":"user"');
    if (!needCwd && !needEp && !needPrompt) return;
    const e = tryParse(line);
    if (!e || typeof e !== 'object') return;
    if (needCwd && typeof e.cwd === 'string') st.cwd = e.cwd;
    if (needEp && typeof e.entrypoint === 'string') st.entrypoint = e.entrypoint;
    if (needPrompt) {
      const t = promptText(e);
      if (t) st.firstPrompt = t;
    }
  }

  private fileOf(id: string): FileState | undefined {
    for (const st of this.files.values()) if (st.id === id) return st;
    return undefined;
  }

  /**
   * Subscribes to a session's messages. Returns the latest page; `onAppend` gets new messages.
   * Call the returned function to unsubscribe.
   */
  async subscribe(
    id: string,
    onAppend: (msgs: Message[]) => void,
  ): Promise<{ messages: Message[]; hasMore: boolean; unsubscribe: () => void }> {
    const st = this.fileOf(id);
    if (!st) throw new Error('Сессия не найдена');
    let sub = this.subs.get(id);
    if (!sub) {
      const messages: Message[] = [];
      const offset = await readLines(st.file, 0, (line) => {
        const m = normalizeEntry(tryParse(line));
        if (m) messages.push(m);
      });
      sub = this.subs.get(id);
      if (!sub) {
        sub = { messages, offset, listeners: new Set(), reading: false, again: false };
        this.subs.set(id, sub);
        this.watchFile(id, st.file);
      }
    }
    const s = sub;
    s.listeners.add(onAppend);
    const start = Math.max(0, s.messages.length - PAGE);
    return {
      messages: s.messages.slice(start),
      hasMore: start > 0,
      unsubscribe: () => {
        s.listeners.delete(onAppend);
        if (!s.listeners.size) {
          this.subs.delete(id);
          this.fileWatchers.get(id)?.close();
          this.fileWatchers.delete(id);
        }
      },
    };
  }

  /** Older messages before `before` uuid (requires an active subscription or reads the file). */
  async loadMore(id: string, before: string): Promise<{ messages: Message[]; hasMore: boolean }> {
    let all = this.subs.get(id)?.messages;
    if (!all) {
      const st = this.fileOf(id);
      if (!st) throw new Error('Сессия не найдена');
      all = [];
      const acc = all;
      await readLines(st.file, 0, (line) => {
        const m = normalizeEntry(tryParse(line));
        if (m) acc.push(m);
      });
    }
    const idx = all.findIndex((m) => m.uuid === before);
    const end = idx < 0 ? 0 : idx;
    const start = Math.max(0, end - PAGE);
    return { messages: all.slice(start, end), hasMore: start > 0 };
  }

  private watchFile(id: string, file: string): void {
    try {
      const w = fs.watch(file, () => void this.tail(id));
      w.on('error', () => w.close());
      this.fileWatchers.set(id, w);
    } catch {
      /* the periodic rescan still triggers tail() */
    }
  }

  private async tail(id: string): Promise<void> {
    const sub = this.subs.get(id);
    const st = this.fileOf(id);
    if (!sub || !st) return;
    if (sub.reading) {
      sub.again = true;
      return;
    }
    sub.reading = true;
    try {
      const fresh: Message[] = [];
      sub.offset = await readLines(st.file, sub.offset, (line) => {
        const m = normalizeEntry(tryParse(line));
        if (m) fresh.push(m);
      });
      if (fresh.length) {
        sub.messages.push(...fresh);
        for (const l of sub.listeners) l(fresh);
      }
    } catch {
      /* file vanished; scan() will drop it */
    } finally {
      sub.reading = false;
      if (sub.again) {
        sub.again = false;
        void this.tail(id);
      }
    }
  }
}
