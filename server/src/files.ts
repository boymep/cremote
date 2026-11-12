import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Безопасная раздача локальных файлов для `GET /api/file`. Правила — в docs/SPEC.md, раздел «Файлы». */

export const MAX_FILE_SIZE = 200 * 1024 * 1024;

export type FileKind = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'binary';

export interface FileInfo {
  file: string;
  size: number;
  kind: FileKind;
  /** Content-Type ответа (уже безопасный: текст всегда text/plain). */
  mime: string;
  attachment: boolean;
}

export type Resolved = { ok: true; info: FileInfo } | { ok: false; status: 400 | 403 | 404; error: string };

export interface ResolveOptions {
  /** cwd сессии, если известен. */
  cwd?: string;
  home?: string;
  uid?: number;
  uploadsDir?: string;
  extraRoots?: string[];
}

const MEDIA: Record<string, [FileKind, string]> = {
  '.png': ['image', 'image/png'],
  '.jpg': ['image', 'image/jpeg'],
  '.jpeg': ['image', 'image/jpeg'],
  '.gif': ['image', 'image/gif'],
  '.webp': ['image', 'image/webp'],
  '.avif': ['image', 'image/avif'],
  '.bmp': ['image', 'image/bmp'],
  '.ico': ['image', 'image/x-icon'],
  '.pdf': ['pdf', 'application/pdf'],
  '.mp4': ['video', 'video/mp4'],
  '.m4v': ['video', 'video/mp4'],
  '.mov': ['video', 'video/quicktime'],
  '.webm': ['video', 'video/webm'],
  '.mp3': ['audio', 'audio/mpeg'],
  '.m4a': ['audio', 'audio/mp4'],
  '.wav': ['audio', 'audio/wav'],
  '.ogg': ['audio', 'audio/ogg'],
};

const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonl', '.csv', '.tsv', '.log', '.yaml', '.yml', '.toml', '.ini', '.html', '.htm',
  '.svg', '.xml', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.svelte', '.vue', '.css', '.scss', '.py', '.rb', '.go',
  '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.zsh', '.bash', '.sql', '.diff',
  '.patch', '.conf', '.cfg', '.env.example', '.lock', '.gradle', '.plist', '.rst', '.tex',
]);

const DENY_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.git', 'Keychains']);
const DENY_NAME = [/^\.env(\..*)?$/i, /^\.netrc$/i, /^\.npmrc$/i, /^\.pypirc$/i, /^\.claude\.json$/i, /^id_(rsa|ed25519|ecdsa|dsa)/i];
const DENY_EXT = new Set(['.pem', '.key', '.p12', '.pfx', '.keystore']);

export function classify(file: string): { kind: FileKind; mime: string; attachment: boolean } {
  const ext = path.extname(file).toLowerCase();
  const media = MEDIA[ext];
  if (media) return { kind: media[0], mime: media[1], attachment: false };
  if (TEXT_EXT.has(ext) || /^(readme|makefile|dockerfile|license)$/i.test(path.basename(file))) {
    return { kind: 'text', mime: 'text/plain; charset=utf-8', attachment: false };
  }
  return { kind: 'binary', mime: 'application/octet-stream', attachment: true };
}

/** true, если путь (уже без симлинков) нельзя отдавать ни из какого корня. */
export function isDenied(file: string, home = os.homedir()): boolean {
  const parts = file.split(path.sep).filter(Boolean);
  const name = parts[parts.length - 1] ?? '';
  if (parts.some((p) => DENY_SEGMENTS.has(p))) return true;
  // .config/gh
  for (let i = 0; i < parts.length - 1; i++) if (parts[i] === '.config' && parts[i + 1] === 'gh') return true;
  if (DENY_NAME.some((re) => re.test(name))) return true;
  if (DENY_EXT.has(path.extname(name).toLowerCase())) return true;
  for (const c of [path.join(home, '.claude'), safeReal(path.join(home, '.claude'))]) {
    if (c && (file === c || file.startsWith(c + path.sep))) return true;
  }
  return false;
}

function safeReal(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

export function allowedRoots(opts: ResolveOptions): string[] {
  const home = opts.home ?? os.homedir();
  const uid = opts.uid ?? (process.getuid?.() ?? 0);
  const candidates = [
    opts.cwd,
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    `/private/tmp/claude-${uid}`,
    `/tmp/claude-${uid}`,
    opts.uploadsDir,
    ...(opts.extraRoots ?? []),
  ];
  const out: string[] = [];
  for (const c of candidates) {
    if (!c || !path.isAbsolute(c)) continue;
    const real = safeReal(c);
    if (real && real !== path.sep && !out.includes(real)) out.push(real);
  }
  return out;
}

/** Убирает file://, якоря `#L10`, `?query` у file:// и разворачивает `~`. */
export function normalizeInput(raw: string, home = os.homedir()): string {
  let p = raw.trim();
  if (p.startsWith('file://')) {
    p = p.slice('file://'.length);
    if (!p.startsWith('/')) p = p.slice(p.indexOf('/') >= 0 ? p.indexOf('/') : p.length);
    try {
      p = decodeURIComponent(p);
    } catch {
      /* оставляем как есть */
    }
  }
  p = p.replace(/#L?\d+(?:[-C,L\d]*)?$/, '');
  if (p === '~') p = home;
  else if (p.startsWith('~/')) p = path.join(home, p.slice(2));
  return p;
}

function tryStat(cwdBase: string | undefined, p: string): { real: string; st: fs.Stats } | 'missing' | 'bad' {
  const abs = path.isAbsolute(p) ? p : cwdBase ? path.resolve(cwdBase, p) : null;
  if (!abs) return 'bad';
  try {
    const real = fs.realpathSync(abs);
    return { real, st: fs.statSync(real) };
  } catch {
    return 'missing';
  }
}

export function resolveFile(raw: string, opts: ResolveOptions = {}): Resolved {
  const home = opts.home ?? os.homedir();
  if (!raw || raw.length > 4096 || raw.includes('\0')) return { ok: false, status: 400, error: 'Некорректный путь' };
  let p = normalizeInput(raw, home);
  if (!p) return { ok: false, status: 400, error: 'Некорректный путь' };
  if (!path.isAbsolute(p) && !opts.cwd) return { ok: false, status: 400, error: 'Относительный путь без сессии' };

  let found = tryStat(opts.cwd, p);
  if (found === 'missing') {
    // Ссылки вида `file.ts:42` или `file.ts:42:7`.
    const stripped = p.replace(/:\d+(?::\d+)?$/, '');
    if (stripped !== p) {
      p = stripped;
      found = tryStat(opts.cwd, p);
    }
  }
  if (found === 'bad') return { ok: false, status: 400, error: 'Некорректный путь' };
  if (found === 'missing') return { ok: false, status: 404, error: 'Файл не найден' };

  const roots = allowedRoots({ ...opts, home });
  const inRoot = roots.some((r) => found.real === r || found.real.startsWith(r + path.sep));
  if (!inRoot || isDenied(found.real, home)) return { ok: false, status: 403, error: 'Доступ к файлу закрыт' };
  if (found.st.isDirectory() || !found.st.isFile()) return { ok: false, status: 404, error: 'Это не файл' };
  if (found.st.size > MAX_FILE_SIZE) return { ok: false, status: 403, error: 'Файл больше 200 МБ' };
  return { ok: true, info: { file: found.real, size: found.st.size, ...classify(found.real) } };
}
