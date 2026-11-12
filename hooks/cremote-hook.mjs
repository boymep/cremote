#!/usr/bin/env node
// Claude Code hook -> cremote server bridge. Zero dependencies.
// Any failure (server down, bad config, non-2xx) exits 0 silently, which Claude Code treats as "no hook".
//
// `Wait` is not a Claude Code event: install.ts registers it as an async `asyncRewake` hook on Stop and
// SessionStart. It long-polls the server while the session is idle. When a phone message arrives it
// prints the message to stderr and exits 2, which makes Claude Code start a new turn with it.
// It never blocks the session: Claude Code does not wait for async hooks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const event = process.argv[2];
const waiting = event === 'Wait';
const quit = () => process.exit(0);
const RETRY_MS = 5000;
const PARENT_POLL_MS = 2000;

if (!event || process.env.CREMOTE_HOOK_DISABLE === '1') quit();

const home = process.env.CREMOTE_HOME || path.join(os.homedir(), '.cremote');
function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    return c?.hookSecret ? c : null;
  } catch {
    return null;
  }
}
if (!readConfig()) quit();

// Claude Code (or the shell it spawned us with) is our parent; when it dies we are re-parented.
const parent = process.ppid;
const parentAlive = () => {
  if (process.ppid !== parent) return false;
  try {
    process.kill(parent, 0);
    return true;
  } catch {
    return false;
  }
};

/** One request to the server. Resolves with the parsed JSON reply, or null on any failure. */
function post(body) {
  const config = readConfig();
  if (!config) return Promise.resolve(null);
  const port = Number(process.env.CREMOTE_PORT) || Number(config.port) || 7878;
  return new Promise((resolve) => {
    // node:http has no default response timeout, unlike fetch: Wait/PermissionRequest may last for hours.
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/hook/${encodeURIComponent(event)}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'X-Cremote-Hook': config.hookSecret,
          // Lets the server map the Claude Code process (our parent chain) to this session.
          'X-Cremote-PPID': String(parent),
        },
      },
      (res) => {
        const out = [];
        res.on('data', (c) => out.push(c));
        res.on('error', () => resolve(null));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          try {
            resolve(JSON.parse(Buffer.concat(out).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.end(body);
    if (waiting) {
      const timer = setInterval(() => {
        if (parentAlive()) return;
        req.destroy();
        quit();
      }, PARENT_POLL_MS);
      req.on('close', () => clearInterval(timer));
    }
  });
}

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', quit);
process.stdin.on('end', async () => {
  const body = Buffer.concat(chunks);
  if (!waiting) {
    const reply = await post(body);
    if (!reply) quit();
    process.stdout.write(JSON.stringify(reply), () => quit());
    return;
  }
  // Wait: an empty reply means "stand down" (replaced, local input, session ended).
  // A dropped connection (server restart) is retried while Claude Code is alive.
  for (;;) {
    const reply = await post(body);
    if (reply && typeof reply.wake === 'string' && reply.wake) {
      process.stderr.write(reply.wake, () => process.exit(2));
      return;
    }
    if (reply) quit();
    await new Promise((r) => setTimeout(r, RETRY_MS));
    if (!parentAlive()) quit();
  }
});
