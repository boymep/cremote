import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Hub } from './hub.js';
import { CREMOTE_HOME, getVapidSubject, readConfig, writeJsonAtomic, type PushSubscriptionRecord } from './config.js';
import type { Pending } from './types.js';

/** Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291), on node:crypto only. */

const VAPID_PATH = path.join(CREMOTE_HOME, 'vapid.json');
const TTL = 3600;
const JWT_LIFETIME_S = 12 * 3600;
const DEBOUNCE_MS = 10_000;
const NOTIFY_DEDUP_MS = 15_000;
const LONG_TURN_MS = 20_000;
/** Pause after a turn end: a queued message or task result may start the next turn right away. */
const TURN_SETTLE_MS = 8_000;
/** How long a background task may delay the final push; a killed task never reports back. */
const AGENT_HOLD_MS = 60 * 60_000;
const SHELL_HOLD_MS = 10 * 60_000;
const BACKGROUND_SCAN_BYTES = 8 * 1024 * 1024;
const SEND_TIMEOUT_MS = 15_000;

const b64u = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('base64url');

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  badge?: number;
}

interface Vapid {
  privateKey: crypto.KeyObject;
  publicKey: string;
}

/** Loads the VAPID key pair, generating it on first use. The private key never leaves vapid.json (0600). */
export function loadVapid(): Vapid {
  let jwk: { d: string; x: string; y: string } | undefined;
  try {
    jwk = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
  } catch {
    /* generate below */
  }
  if (!jwk?.d || !jwk.x || !jwk.y) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const e = privateKey.export({ format: 'jwk' });
    jwk = { d: e.d!, x: e.x!, y: e.y! };
    writeJsonAtomic(VAPID_PATH, jwk, 0o600);
  }
  const privateKey = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', ...jwk }, format: 'jwk' });
  const publicKey = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
  return { privateKey, publicKey };
}

function vapidHeader(v: Vapid, endpoint: string): string {
  const aud = new URL(endpoint).origin;
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(
    Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + JWT_LIFETIME_S, sub: getVapidSubject(readConfig()) })),
  );
  const data = `${head}.${claims}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: v.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${v.publicKey}`;
}

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, len: number): Buffer =>
  Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

/** RFC 8291 aes128gcm body for a single record. */
export function encryptPayload(keys: { p256dh: string; auth: string }, plaintext: Buffer): Buffer {
  const uaPub = Buffer.from(keys.p256dh, 'base64url');
  const authSecret = Buffer.from(keys.auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPub);
  const salt = crypto.randomBytes(16);
  const prk = hkdf(secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const cek = hkdf(prk, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(prk, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, body]);
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Last assistant text of a transcript (reads only the file tail), single-lined. */
function lastAssistantText(file: string | undefined): string {
  if (!file) return '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"assistant"')) continue;
        let o: any;
        try {
          o = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        if (o?.type !== 'assistant' || o.isSidechain) continue;
        const c = o.message?.content;
        const text = Array.isArray(c)
          ? c.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join(' ')
          : typeof c === 'string'
            ? c
            : '';
        if (text.trim()) return text.replace(/\s+/g, ' ').trim();
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* no transcript yet */
  }
  return '';
}

/**
 * Until when background tasks of the session may still bring a next turn (0: nothing is running).
 * A task counts from its launch in the transcript until its <task-notification> arrives.
 */
export function backgroundHoldUntil(file: string | undefined, now = Date.now()): number {
  if (!file) return 0;
  let tail: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, BACKGROUND_SCAN_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      tail = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 0;
  }
  const launched: { ids: string[]; until: number }[] = [];
  const done = new Set<string>();
  for (const line of tail.split('\n')) {
    const isLaunch = line.includes('async_launched') || line.includes('backgroundTaskId');
    const isDone = line.includes('<task-notification');
    if (!isLaunch && !isDone) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.isSidechain || o?.type === 'assistant') continue;
    if (isDone) for (const m of line.matchAll(/<(?:task-id|tool-use-id)>([^<]+)</g)) done.add(m[1]);
    const r = o?.toolUseResult;
    if (o?.type !== 'user' || !r || typeof r !== 'object') continue;
    const isAgent = r.status === 'async_launched';
    if (!isAgent && !r.backgroundTaskId) continue;
    const toolUseId = Array.isArray(o.message?.content) ? o.message.content.find((b: any) => b?.tool_use_id)?.tool_use_id : undefined;
    launched.push({
      ids: [toolUseId, r.agentId, r.backgroundTaskId].filter(Boolean),
      until: (Date.parse(o.timestamp) || 0) + (isAgent ? AGENT_HOLD_MS : SHELL_HOLD_MS),
    });
  }
  let until = 0;
  for (const t of launched) if (t.until > now && !t.ids.some((id) => done.has(id))) until = Math.max(until, t.until);
  return until;
}

/** Markdown markers read as noise in a notification. */
function plainText(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hint(input: unknown): string {
  const i = input as Record<string, unknown> | null;
  const v = i && (i.command ?? i.file_path ?? i.path ?? i.url ?? i.pattern);
  return typeof v === 'string' ? clip(v.replace(/\s+/g, ' ').trim(), 60) : '';
}

export class PushService {
  private vapid = loadVapid();
  private lastByTag = new Map<string, number>();
  private lastPendingPush = new Map<string, number>();
  private workStart = new Map<string, number>();
  private finalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private seen = new Set<string>();

  constructor(private hub: Hub) {
    hub.on('pending', (list: Pending[]) => this.onPending(list));
    hub.on('notify', (n: { sessionId: string; title: string; message: string }) => this.onNotify(n));
    hub.on('working', (id: string) => this.onWorking(id));
    hub.on('turnend', (id: string) => this.scheduleFinal(id, TURN_SETTLE_MS));
  }

  get publicKey(): string {
    return this.vapid.publicKey;
  }

  private subs(): Record<string, PushSubscriptionRecord> {
    return (this.hub.state.pushSubscriptions ??= {});
  }

  subscribe(sub: unknown): boolean {
    const s = sub as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
    const endpoint = s?.endpoint;
    const p256dh = s?.keys?.p256dh;
    const auth = s?.keys?.auth;
    if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') return false;
    if (endpoint.length > 2048 || !/^https:\/\//.test(endpoint)) return false;
    if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length < 16) return false;
    this.subs()[endpoint] = { endpoint, keys: { p256dh, auth }, createdAt: Date.now() };
    this.hub.persistState();
    return true;
  }

  unsubscribe(endpoint: string): void {
    if (this.subs()[endpoint]) {
      delete this.subs()[endpoint];
      this.hub.persistState();
    }
  }

  private projectOf(sessionId: string): string {
    const cwd = this.hub.live.get(sessionId)?.cwd || this.hub.transcripts.get(sessionId)?.cwd || '';
    return path.basename(cwd) || 'cremote';
  }

  /** Sends unless the phone app is in the foreground or the same tag fired within 10 s. */
  private notifyPhone(sessionId: string, p: PushPayload, urgent: boolean): void {
    if (this.hub.phoneForeground()) return;
    const tag = p.tag ?? sessionId;
    const now = Date.now();
    if (now - (this.lastByTag.get(tag) ?? 0) < DEBOUNCE_MS) return;
    this.lastByTag.set(tag, now);
    void this.sendAll({ ...p, tag, url: `/#/s/${sessionId}`, badge: this.hub.pending.list().length }, urgent);
  }

  private onPending(list: Pending[]): void {
    const ids = new Set(list.map((p) => p.id));
    for (const p of list) {
      if (this.seen.has(p.id)) continue;
      this.seen.add(p.id);
      this.lastPendingPush.set(p.sessionId, Date.now());
      const body =
        p.kind === 'permission' && p.blocked
          ? `Заблокировано классификатором: ${p.toolName}${hint(p.input) ? ` — ${hint(p.input)}` : ''}`
          : p.kind === 'permission'
          ? `Нужно разрешение: ${p.toolName}${hint(p.input) ? ` — ${hint(p.input)}` : ''}`
          : 'Claude задаёт вопрос';
      this.notifyPhone(p.sessionId, { title: this.projectOf(p.sessionId), body, tag: `perm-${p.sessionId}` }, true);
    }
    for (const id of this.seen) if (!ids.has(id)) this.seen.delete(id);
  }

  private onNotify(n: { sessionId: string; title: string; message: string }): void {
    if (Date.now() - (this.lastPendingPush.get(n.sessionId) ?? 0) < NOTIFY_DEDUP_MS) return;
    this.notifyPhone(
      n.sessionId,
      { title: this.projectOf(n.sessionId), body: clip(n.message || n.title, 120), tag: `note-${n.sessionId}` },
      false,
    );
  }

  /** Work resumed, so the previous turn end was not final. Time counts from the first turn of the chain. */
  private onWorking(sessionId: string): void {
    clearTimeout(this.finalTimers.get(sessionId));
    this.finalTimers.delete(sessionId);
    if (!this.workStart.has(sessionId)) this.workStart.set(sessionId, Date.now());
  }

  private scheduleFinal(sessionId: string, delay: number): void {
    clearTimeout(this.finalTimers.get(sessionId));
    this.finalTimers.set(sessionId, setTimeout(() => this.onFinalCheck(sessionId), delay));
  }

  /** Pushes the last message only when the session went quiet and no background task is left. */
  private onFinalCheck(sessionId: string): void {
    this.finalTimers.delete(sessionId);
    const file = this.hub.live.get(sessionId)?.transcriptPath ?? this.hub.transcripts.get(sessionId)?.file;
    const now = Date.now();
    const holdUntil = backgroundHoldUntil(file, now);
    if (holdUntil) return this.scheduleFinal(sessionId, holdUntil - now + 1000);
    const started = this.workStart.get(sessionId);
    this.workStart.delete(sessionId);
    if (!started || now - started < LONG_TURN_MS) return;
    this.notifyPhone(
      sessionId,
      { title: this.projectOf(sessionId), body: clip(plainText(lastAssistantText(file)), 200) || 'Claude закончил', tag: `done-${sessionId}` },
      false,
    );
  }

  /** Test push from /api/push/test: ignores presence and debounce. */
  async sendTest(): Promise<void> {
    await this.sendAll({ title: 'cremote', body: 'Тестовое уведомление', tag: 'test', badge: this.hub.pending.list().length }, false);
  }

  private async sendAll(payload: PushPayload, urgent: boolean): Promise<void> {
    const body = Buffer.from(JSON.stringify(payload));
    await Promise.all(Object.values(this.subs()).map((s) => this.sendOne(s, body, urgent)));
  }

  private async sendOne(sub: PushSubscriptionRecord, body: Buffer, urgent: boolean): Promise<void> {
    try {
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: vapidHeader(this.vapid, sub.endpoint),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(TTL),
          Urgency: urgent ? 'high' : 'normal',
        },
        body: new Uint8Array(encryptPayload(sub.keys, body)),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (res.status === 404 || res.status === 410) this.unsubscribe(sub.endpoint);
      else if (!res.ok) console.warn(`[push] ${new URL(sub.endpoint).host} -> ${res.status}`);
    } catch (e) {
      console.warn(`[push] ${new URL(sub.endpoint).host} failed: ${e instanceof Error ? e.message : 'error'}`);
    }
  }
}
