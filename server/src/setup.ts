import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashPassword } from './auth.js';
import { DEFAULT_REMOTE_PORT, ensureConfig, getAccess, writeConfig, type AccessConfig, type Config } from './config.js';
import { installHooks } from './install.js';
import { Prompter } from './prompt.js';
import { currentPlatform, findBinary, serviceInstall } from './service.js';
import { SSH_HINT, accessUrl, claudeLoggedIn, findClaude, findTailscale, nodeOk, tailscaleDnsName, testSsh, MIN_NODE_MAJOR } from './checks.js';

const ok = (m: string) => console.log(`✓ ${m}`);
const warn = (m: string) => console.log(`! ${m}`);
const step = (m: string) => console.log(`\n== ${m}`);

async function askPassword(p: Prompter, cfg: Config): Promise<Config> {
  if (cfg.passwordHash && !(await p.confirm('Пароль уже задан. Сменить?', false))) {
    ok('Пароль оставлен как есть');
    return cfg;
  }
  for (;;) {
    const pass = await p.secret('Новый пароль (не короче 8 символов)');
    if (pass.length < 8) {
      warn('Пароль слишком короткий');
      if (!process.stdin.isTTY) throw new Error('Пароль не задан');
      continue;
    }
    const again = await p.secret('Повторите пароль');
    if (again !== pass) {
      warn('Пароли не совпадают');
      if (!process.stdin.isTTY) throw new Error('Пароли не совпадают');
      continue;
    }
    ok('Пароль сохранён');
    return { ...cfg, passwordHash: hashPassword(pass) };
  }
}

async function askAccess(p: Prompter, cfg: Config): Promise<AccessConfig> {
  const cur = getAccess(cfg);
  const modes = ['tailscale', 'cloudflare', 'ssh', 'none'] as const;
  console.log('Как открывать cremote с телефона?');
  console.log('  1) Tailscale (рекомендуется, без домена)');
  console.log('  2) Cloudflare Tunnel');
  console.log('  3) SSH-туннель на свой VPS');
  console.log('  4) Только локально');
  const defIdx = cur.mode === 'none' && !cfg.access && !cfg.tunnel ? 1 : modes.indexOf(cur.mode) + 1;
  let mode: (typeof modes)[number];
  for (;;) {
    const a = await p.ask('Ваш выбор', String(defIdx));
    mode = modes[Number(a) - 1];
    if (mode) break;
    warn('Введите число от 1 до 4');
    if (!process.stdin.isTTY) throw new Error('Не выбран режим доступа');
  }
  const port = cfg.port ?? 7878;

  if (mode === 'none') return { mode };

  if (mode === 'ssh') {
    const target = await p.ask('SSH-адрес VPS (user@host)', cur.ssh?.target);
    if (!target) throw new Error('Адрес VPS не задан');
    const remotePort = Number(await p.ask('Порт на VPS, куда пробрасывается cremote', String(cur.ssh?.remotePort ?? DEFAULT_REMOTE_PORT))) || DEFAULT_REMOTE_PORT;
    const idAnswer = await p.ask('Файл ключа (Enter — по умолчанию; «-» — сбросить)', cur.ssh?.identityFile);
    const identityFile = idAnswer === '-' || !idAnswer ? undefined : idAnswer.replace(/^~(?=\/)/, os.homedir());
    const publicUrl = (await p.ask('Публичный адрес для телефона (необязательно)', cur.publicUrl)) || undefined;
    console.log(`Проверяю вход: ssh ${target} ...`);
    const t = testSsh(target, identityFile);
    if (t.ok) ok('SSH-вход работает');
    else {
      warn(`Не удалось войти без пароля${t.error ? `: ${t.error}` : ''}`);
      console.log(`  ${SSH_HINT}`);
      if (!(await p.confirm('Продолжить всё равно?', false))) throw new Error('Настройка прервана: SSH не работает');
    }
    return { mode, ssh: { target, remotePort, ...(identityFile ? { identityFile } : {}) }, ...(publicUrl ? { publicUrl } : {}) };
  }

  if (mode === 'cloudflare') {
    if (!findBinary('cloudflared')) warn('cloudflared не найден в PATH. Установите его до установки сервисов: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
    console.log(`В Cloudflare Zero Trust создайте туннель, добавьте публичный адрес с сервисом http://localhost:${port} и скопируйте токен.`);
    const entered = await p.secret(`Токен туннеля${cur.cloudflare?.token ? ' (Enter — оставить текущий)' : ''}`);
    const token = entered || cur.cloudflare?.token;
    if (!token) throw new Error('Токен не задан');
    const publicUrl = (await p.ask('Публичный адрес туннеля (https://…)', cur.publicUrl)) || undefined;
    return { mode, cloudflare: { token }, ...(publicUrl ? { publicUrl } : {}) };
  }

  // tailscale
  const ts = findTailscale();
  if (!ts) {
    warn('Команда tailscale не найдена. Установите Tailscale и войдите: https://tailscale.com/download');
  } else if (await p.confirm(`Выполнить «tailscale serve --bg http://127.0.0.1:${port}»?`, true)) {
    const r = spawnSync(ts, ['serve', '--bg', `http://127.0.0.1:${port}`], { encoding: 'utf8', timeout: 30_000 });
    if (r.status === 0) ok('tailscale serve включён');
    else warn(`tailscale serve не сработал: ${(r.stderr || r.stdout || r.error?.message || '').trim()}`);
  }
  return { mode };
}

export async function setup(): Promise<void> {
  console.log('Мастер настройки cremote\n');
  step('Проверки');
  if (!nodeOk()) throw new Error(`Нужен Node.js ${MIN_NODE_MAJOR} или новее, сейчас ${process.versions.node}`);
  ok(`Node.js ${process.versions.node}`);
  const claude = findClaude();
  if (claude) ok(`claude найден: ${claude}`);
  else warn('Команда claude не найдена. Установите Claude Code: https://docs.claude.com/en/docs/claude-code');
  if (claude) {
    if (claudeLoggedIn()) ok('Вход в Claude выполнен');
    else warn('Похоже, вход в Claude не выполнен. Запустите «claude» и войдите.');
  }

  const p = new Prompter();
  try {
    let cfg = ensureConfig();

    step('Пароль');
    cfg = await askPassword(p, cfg);
    writeConfig(cfg);

    step('Доступ с телефона');
    const access = await askAccess(p, cfg);
    const { tunnel: _legacy, ...rest } = cfg;
    cfg = { ...rest, access };
    writeConfig(cfg);
    ok(`Режим доступа: ${access.mode}`);

    step('cswap (необязательно)');
    const cswap = findBinary('cswap');
    if (cfg.cswapPath && fs.existsSync(cfg.cswapPath)) ok(`cswap: ${cfg.cswapPath}`);
    else if (cswap) {
      ok(`cswap найден: ${cswap}`);
      if (cswap !== path.join(os.homedir(), '.local', 'bin', 'cswap')) {
        cfg = { ...cfg, cswapPath: cswap };
        writeConfig(cfg);
      }
    } else {
      const given = await p.ask('Путь к cswap для переключения аккаунтов (Enter — пропустить)');
      if (given && fs.existsSync(given)) {
        cfg = { ...cfg, cswapPath: given };
        writeConfig(cfg);
        ok(`cswap: ${given}`);
      } else console.log('cswap пропущен');
    }

    step('Хуки Claude Code');
    if (await p.confirm('Добавить хуки в ~/.claude/settings.json?', true)) {
      const r = installHooks();
      ok(`Хуки добавлены в ${r.file}${r.backup ? ` (копия: ${r.backup})` : ''}`);
    } else console.log('Хуки пропущены');

    step('Сервисы');
    let platformOk = true;
    try {
      currentPlatform();
    } catch (e) {
      platformOk = false;
      warn((e as Error).message);
    }
    if (platformOk && (await p.confirm('Установить сервисы автозапуска?', true))) {
      try {
        const r = serviceInstall(true);
        for (const f of r.files) ok(`Установлен ${f}`);
        for (const h of r.hints) console.log(`  ${h}`);
      } catch (e) {
        warn(`Сервисы не установлены: ${(e as Error).message}`);
      }
    } else console.log('Сервисы пропущены. Запуск вручную: cremote start');

    step('Готово');
    const port = cfg.port ?? 7878;
    const ts = access.mode === 'tailscale' ? findTailscale() : null;
    console.log(`Адрес: ${accessUrl(access, port, ts ? tailscaleDnsName(ts) : null)}`);
    console.log('Перезагрузите окна VS Code, чтобы расширение Claude подхватило хуки.');
    console.log('Проверить состояние: cremote doctor');
  } finally {
    p.close();
  }
}
