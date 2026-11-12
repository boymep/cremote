import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { Auth, clearCookie, clientIp, isLoopback, sessionCookie, verifyPassword } from './auth.js';
import { HOST, PORT, UPLOADS_DIR, WEB_DIST, ensureConfig, getAutoUpdate, getVersion, readState, writeConfig, writeState, type Config } from './config.js';
import { HOOK_EVENTS, handleHook, type HookEvent } from './hooks.js';
import { Hub, mediaToExt } from './hub.js';
import { SdkManager } from './sdk.js';
import { TranscriptStore } from './transcripts.js';
import { AccountsMonitor } from './accounts.js';
import { ProcessTracker } from './processes.js';
import { UpdateWatcher } from './update.js';
import { createWs } from './ws.js';
import { PushService } from './push.js';
import { allowedRoots, resolveFile } from './files.js';
import { createGrant, resolveRaw } from './grants.js';

const MAX_UPLOAD = 10 * 1024 * 1024;
const MAX_JSON = 2 * 1024 * 1024;
const MAX_PUSH_JSON = 8 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Отдаёт файл целиком или по Range (200/206/416). */
function sendRanged(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  size: number,
  headers: Record<string, string | number>,
): void {
  let start = 0;
  let end = size - 1;
  let status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (m && (m[1] || m[2])) {
    if (m[1]) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(end, Number(m[2]));
    } else {
      start = Math.max(0, size - Number(m[2]));
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return void res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) return void res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage, limit = MAX_JSON): Promise<any> {
  const buf = await readBody(req, limit);
  try {
    return buf.length ? JSON.parse(buf.toString('utf8')) : {};
  } catch {
    throw new HttpError(400, 'Некорректный JSON');
  }
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  const root = WEB_DIST;
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: 'bad path' });
  }
  let file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep) && file !== root) return sendJson(res, 404, { error: 'not found' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // SPA fallback for client-side routes; real asset misses stay 404.
    if (path.extname(rel)) return sendJson(res, 404, { error: 'not found' });
    file = path.join(root, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      return void res.end('cremote: web/dist не собран. Выполните npm run build.');
    }
  }
  const ext = path.extname(file);
  const immutable = rel.startsWith('/assets/');
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return void res.end();
  fs.createReadStream(file).pipe(res);
}

export async function startServer(): Promise<http.Server> {
  const config: Config = ensureConfig();
  if (process.env.CREMOTE_PORT && config.port !== PORT) writeConfig({ ...config, port: PORT });
  if (!config.passwordHash) console.warn('[cremote] Пароль не задан: выполните `cremote passwd`, иначе вход невозможен.');

  const state = readState();
  const auth = new Auth(state, () => writeState(state));
  const transcripts = new TranscriptStore();
  const hub = new Hub(transcripts, state, () => writeState(state));
  hub.sdk = new SdkManager(hub);
  if (typeof config.phonePresenceMs === 'number' && config.phonePresenceMs > 0) hub.phonePresenceMs = config.phonePresenceMs;
  const accounts = new AccountsMonitor(hub);
  hub.accounts = accounts;
  accounts.start();
  const processes = new ProcessTracker(hub);
  hub.processes = processes;
  fs.mkdirSync(UPLOADS_DIR, { recursive: true, mode: 0o700 });
  await transcripts.start();
  const updates = new UpdateWatcher(
    () => getAutoUpdate(config),
    () => hub.sessions().some((x) => x.status === 'working'),
    (info) => ws.broadcast({ type: 'update', ...info }),
  );
  const ws = createWs(hub, auth, updates);
  updates.start();
  const push = new PushService(hub);

  const handleHookRequest = async (req: IncomingMessage, res: ServerResponse, event: string) => {
    const secret = req.headers['x-cremote-hook'];
    const ok =
      isLoopback(req.socket.remoteAddress) &&
      typeof secret === 'string' &&
      secret.length === config.hookSecret.length &&
      crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(config.hookSecret));
    if (!ok || req.method !== 'POST') return sendJson(res, 404, { error: 'not found' });
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) return sendJson(res, 200, {});
    const input = await readJson(req);
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });
    const sid = typeof input?.session_id === 'string' ? input.session_id : '';
    const ppid = Number(req.headers['x-cremote-ppid']) || undefined;
    // Fire and forget: mapping must not delay the hook reply.
    if (sid) void processes.noteHook(sid, ppid, event).catch((e) => console.error('[processes]', e));
    const reply = await handleHook(hub, event as HookEvent, input, ac.signal);
    if (!res.destroyed) sendJson(res, 200, reply);
  };

  const serveFile = (req: IncomingMessage, res: ServerResponse) => {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    const sid = q.get('session');
    const cwd = sid ? hub.sessions().find((s) => s.id === sid)?.cwd || undefined : undefined;
    const r = resolveFile(q.get('path') ?? '', { cwd, uploadsDir: UPLOADS_DIR, extraRoots: ensureConfig().fileRoots });
    if (!r.ok) return sendJson(res, r.status, { error: r.error });
    const { info } = r;
    if (q.get('meta') === '1') {
      return sendJson(res, 200, { name: path.basename(info.file), size: info.size, kind: info.kind, mime: info.mime, path: info.file });
    }
    const headers: Record<string, string | number> = {
      'Content-Type': info.mime,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'private, max-age=60',
    };
    // Chrome не открывает pdf внутри sandbox/default-src 'none', а pdf-просмотрщик браузера изолирован сам.
    if (info.kind === 'pdf') delete headers['Content-Security-Policy'];
    if (info.attachment) {
      headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(info.file))}`;
    }
    sendRanged(req, res, info.file, info.size, headers);
  };

  /** `GET /api/raw/<token>/<путь>`: без cookie, доступ по токену. Путь разбирается вручную: URL нормализует `%2e%2e`. */
  const serveRaw = (req: IncomingMessage, res: ServerResponse) => {
    const notFound = (status = 404) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' });
      res.end('not found');
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(405);
    const rawPath = (req.url ?? '').split(/[?#]/)[0].slice('/api/raw/'.length);
    const parts = rawPath.split('/');
    const token = parts.shift() ?? '';
    let segments: string[];
    try {
      segments = parts.map((p) => decodeURIComponent(p));
    } catch {
      return notFound(400);
    }
    const r = resolveRaw(token, segments);
    if (!r.ok) return notFound(r.status);
    sendRanged(req, res, r.file, r.size, {
      'Content-Type': r.mime,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox allow-scripts allow-popups allow-forms',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'private, no-store',
    });
  };

  const handleApi = async (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    if (pathname === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (auth.isRateLimited(ip)) return sendJson(res, 429, { error: 'Слишком много попыток. Попробуйте позже' });
      const body = await readJson(req);
      const cfg = ensureConfig();
      if (typeof body.password !== 'string' || !verifyPassword(body.password, cfg.passwordHash)) {
        auth.recordFailure(ip);
        return sendJson(res, 401, { error: 'Неверный пароль' });
      }
      const { token, maxAgeSec } = auth.createSession();
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, maxAgeSec) });
    }
    if (pathname === '/api/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, version: getVersion() });
    if (!auth.isAuthed(req)) return sendJson(res, 401, { error: 'Требуется вход' });

    if (pathname === '/api/me' && req.method === 'GET') return sendJson(res, 200, { ok: true });
    if (pathname === '/api/logout' && req.method === 'POST') {
      auth.deleteSession(auth.tokenFrom(req));
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
    }
    if (pathname === '/api/file' && (req.method === 'GET' || req.method === 'HEAD')) return serveFile(req, res);
    if (pathname === '/api/file/grant' && req.method === 'POST') {
      const body = await readJson(req);
      const sid = typeof body?.session === 'string' ? body.session : '';
      const cwd = sid ? hub.sessions().find((s) => s.id === sid)?.cwd || undefined : undefined;
      const opts = { cwd, uploadsDir: UPLOADS_DIR, extraRoots: ensureConfig().fileRoots };
      const r = resolveFile(typeof body?.path === 'string' ? body.path : '', opts);
      if (!r.ok) return sendJson(res, r.status, { error: r.error });
      const token = createGrant(r.info.file, allowedRoots(opts));
      const url = `/api/raw/${token}/${encodeURIComponent(path.basename(r.info.file))}`;
      return sendJson(res, 200, { token, url, expiresIn: 1800 });
    }
    if (pathname === '/api/projects' && req.method === 'GET') return sendJson(res, 200, hub.projects());
    if (pathname === '/api/models' && req.method === 'GET') return sendJson(res, 200, await hub.sdk!.models());
    if (pathname === '/api/accounts' && req.method === 'GET') {
      // Without WS clients nothing polls, so fetch on demand (at most once per 10 s).
      return sendJson(res, 200, await accounts.refreshManual());
    }
    if (pathname === '/api/upload' && req.method === 'POST') {
      const mediaType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const ext = mediaType.startsWith('image/') ? mediaToExt(mediaType) : null;
      if (!ext) return sendJson(res, 415, { error: 'Можно загружать только картинки' });
      if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD) return sendJson(res, 413, { error: 'Файл больше 10 МБ' });
      const data = await readBody(req, MAX_UPLOAD);
      if (!data.length) return sendJson(res, 400, { error: 'Пустой файл' });
      const id = crypto.randomBytes(16).toString('hex');
      const file = path.join(UPLOADS_DIR, `${id}.${ext}`);
      fs.writeFileSync(file, data, { mode: 0o600 });
      return sendJson(res, 200, { id, path: file, mediaType: mediaType === 'image/jpg' ? 'image/jpeg' : mediaType });
    }
    if (pathname === '/api/push/key' && req.method === 'GET') return sendJson(res, 200, { publicKey: push.publicKey });
    if (pathname.startsWith('/api/push/') && req.method === 'POST') {
      const body = await readJson(req, MAX_PUSH_JSON);
      if (pathname === '/api/push/subscribe') {
        if (!push.subscribe(body?.subscription)) return sendJson(res, 400, { error: 'Некорректная подписка' });
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === '/api/push/unsubscribe') {
        if (typeof body?.endpoint !== 'string') return sendJson(res, 400, { error: 'Не указан endpoint' });
        push.unsubscribe(body.endpoint);
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === '/api/push/test') {
        await push.sendTest();
        return sendJson(res, 200, { ok: true });
      }
    }
    return sendJson(res, 404, { error: 'not found' });
  };

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    const run = async () => {
      if (pathname.startsWith('/hook/')) return handleHookRequest(req, res, pathname.slice('/hook/'.length));
      if (pathname.startsWith('/api/raw/')) return serveRaw(req, res);
      if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
      return serveStatic(req, res, pathname);
    };
    run().catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error('[http]', e);
      if (!res.headersSent && !res.destroyed) sendJson(res, status, { error: e instanceof HttpError ? e.message : 'Внутренняя ошибка' });
    });
  });
  // Hook requests may legitimately wait for a day.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.on('upgrade', (req, socket, head) => ws.handleUpgrade(req, socket, head));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => resolve());
  });
  console.log(`[cremote] listening on http://${HOST}:${PORT}, ${transcripts.list().length} transcripts indexed`);

  const shutdown = () => {
    hub.persistLive();
    accounts.stop();
    updates.stop();
    processes.stop();
    ws.close();
    transcripts.stop();
    server.close();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}
