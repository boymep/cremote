import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_FILE_SIZE, isDenied } from './files.js';

/**
 * Временные «гранты» для `GET /api/raw/<token>/<путь>`: HTML-предпросмотр в sandbox-iframe без cookie.
 * Токен привязан к каталогу HTML-файла (и его поддереву), живёт 30 минут, хранится только в памяти.
 */

export const GRANT_TTL_MS = 30 * 60 * 1000;
export const MAX_GRANTS = 200;

interface Grant {
  dir: string;
  roots: string[];
  home?: string;
  expires: number;
}

const grants = new Map<string, Grant>();

const RAW_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

function prune(now: number): void {
  for (const [t, g] of grants) if (g.expires <= now) grants.delete(t);
  // Самые старые уходят первыми (Map хранит порядок вставки).
  while (grants.size >= MAX_GRANTS) {
    const first = grants.keys().next().value;
    if (first === undefined) break;
    grants.delete(first);
  }
}

/** `file` — уже проверенный realpath HTML-файла; roots — разрешённые корни на момент выдачи. */
export function createGrant(file: string, roots: string[], home?: string, now = Date.now()): string {
  prune(now);
  const token = crypto.randomBytes(32).toString('base64url');
  grants.set(token, { dir: path.dirname(file), roots, home, expires: now + GRANT_TTL_MS });
  return token;
}

export function clearGrants(): void {
  grants.clear();
}

export type RawResult =
  | { ok: true; file: string; size: number; mime: string }
  | { ok: false; status: 400 | 403 | 404 };

/** `segments` — уже декодированные сегменты пути внутри каталога гранта. */
export function resolveRaw(token: string, segments: string[], now = Date.now()): RawResult {
  const g = grants.get(token);
  if (!g || g.expires <= now) {
    if (g) grants.delete(token);
    return { ok: false, status: 404 };
  }
  for (const s of segments) {
    if (s === '..' || s === '.' || s.includes('/') || s.includes('\\') || s.includes('\0')) return { ok: false, status: 400 };
  }
  const rel = segments.filter(Boolean);
  if (!rel.length) return { ok: false, status: 404 };
  let real: string;
  let st: fs.Stats;
  try {
    real = fs.realpathSync(path.join(g.dir, ...rel));
    st = fs.statSync(real);
  } catch {
    return { ok: false, status: 404 };
  }
  const inside = (r: string) => real === r || real.startsWith(r + path.sep);
  if (!inside(g.dir) || !g.roots.some(inside) || isDenied(real, g.home)) return { ok: false, status: 403 };
  if (!st.isFile()) return { ok: false, status: 404 };
  if (st.size > MAX_FILE_SIZE) return { ok: false, status: 403 };
  const mime = RAW_MIME[path.extname(real).toLowerCase()] ?? 'application/octet-stream';
  return { ok: true, file: real, size: st.size, mime };
}
