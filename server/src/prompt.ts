import readline from 'node:readline';
import { Writable } from 'node:stream';

/** Reads a line without echo on a TTY; reads stdin as-is when piped. */
export function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c) => (data += c));
      stdin.on('end', () => resolve(data.split(/\r?\n/)[0] ?? ''));
    });
  }
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (c === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * Line-based prompter that works both on a TTY and with piped stdin (lines are queued, EOF answers '').
 * Secret answers are not echoed on a TTY.
 */
export class Prompter {
  private rl: readline.Interface;
  private muted = false;
  private queue: string[] = [];
  private waiters: ((l: string) => void)[] = [];
  private closed = false;

  constructor() {
    const out = new Writable({
      write: (chunk, _enc, cb) => {
        if (!this.muted) process.stdout.write(chunk);
        cb();
      },
    });
    this.rl = readline.createInterface({ input: process.stdin, output: out, terminal: !!process.stdin.isTTY });
    this.rl.on('line', (l) => {
      const w = this.waiters.shift();
      if (w) w(l);
      else this.queue.push(l);
    });
    this.rl.on('close', () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w('');
    });
  }

  private next(): Promise<string> {
    const q = this.queue.shift();
    if (q !== undefined) return Promise.resolve(q);
    if (this.closed) return Promise.resolve('');
    return new Promise((r) => this.waiters.push(r));
  }

  /** Free-text question; empty answer returns `def`. */
  async ask(question: string, def?: string): Promise<string> {
    process.stdout.write(`${question}${def ? ` [${def}]` : ''}: `);
    const a = (await this.next()).trim();
    if (!process.stdin.isTTY) process.stdout.write('\n');
    return a || def || '';
  }

  async secret(question: string): Promise<string> {
    process.stdout.write(`${question}: `);
    this.muted = true;
    const a = await this.next();
    this.muted = false;
    process.stdout.write('\n');
    return a;
  }

  /** Yes/no question. */
  async confirm(question: string, def = true): Promise<boolean> {
    const a = (await this.ask(`${question} ${def ? '[Д/н]' : '[д/Н]'}`)).toLowerCase();
    if (!a) return def;
    return ['д', 'да', 'y', 'yes'].includes(a);
  }

  close(): void {
    this.rl.close();
  }
}
