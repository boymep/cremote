import fs from 'node:fs';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { HOOK_SCRIPT, PORT, getAccess, getVersion, readConfig } from './config.js';
import { EXPECTED_HOOK_EVENTS, listInstalledHooks } from './install.js';
import { currentPlatform, findBinary, serviceStatus } from './service.js';
import { MIN_NODE_MAJOR, claudeLoggedIn, findClaude, findTailscale, nodeOk, tailscaleDnsName, testSsh } from './checks.js';

function getHealth(port: number): Promise<{ ok: boolean; version?: string; error?: string }> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(res.statusCode === 200 && j.ok ? { ok: true, version: j.version } : { ok: false, error: `HTTP ${res.statusCode}` });
        } catch {
          resolve({ ok: false, error: `HTTP ${res.statusCode}, неожиданный ответ` });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('таймаут')));
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

/** Splits `'/a b/node' '/x/script.mjs' Event` into tokens (single quotes as written by hookCommand). */
export function splitHookCommand(cmd: string): string[] {
  const out: string[] = [];
  const re = /'((?:[^']|'\\'')*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]);
  return out;
}

/** Runs all checks, prints them and returns the exit code (1 if anything failed). */
export async function doctor(): Promise<number> {
  let fails = 0;
  const good = (m: string) => console.log(`✓ ${m}`);
  const bad = (m: string, hint?: string) => {
    fails++;
    console.log(`✗ ${m}${hint ? `\n    ${hint}` : ''}`);
  };
  const info = (m: string) => console.log(`  ${m}`);

  if (nodeOk()) good(`Node.js ${process.versions.node}`);
  else bad(`Node.js ${process.versions.node}: нужен ${MIN_NODE_MAJOR} или новее`);

  const claude = findClaude();
  if (!claude) bad('Команда claude не найдена', 'Установите Claude Code и войдите командой «claude».');
  else {
    good(`claude: ${claude}`);
    if (claudeLoggedIn()) good('Вход в Claude выполнен');
    else bad('Вход в Claude не найден', 'Запустите «claude» и войдите.');
  }

  const { file, byEvent } = listInstalledHooks();
  const missing = EXPECTED_HOOK_EVENTS.filter((e) => !byEvent[e]?.length);
  if (missing.length === EXPECTED_HOOK_EVENTS.length) bad(`Хуки не установлены в ${file}`, 'Выполните «cremote hooks install».');
  else {
    if (missing.length) bad(`Нет хуков для событий: ${missing.join(', ')}`, 'Выполните «cremote hooks install».');
    const broken = new Set<string>();
    for (const cmds of Object.values(byEvent)) {
      for (const c of cmds) {
        const [node, script] = splitHookCommand(c);
        if (!node || !fs.existsSync(node)) broken.add(`node не найден: ${node}`);
        if (!script || !fs.existsSync(script)) broken.add(`скрипт не найден: ${script}`);
        else if (script !== HOOK_SCRIPT) broken.add(`скрипт хука из другой установки: ${script}`);
      }
    }
    if (broken.size) bad('Хуки указывают на несуществующие файлы', [...broken].join('; ') + '. Выполните «cremote hooks install».');
    else if (!missing.length) good(`Хуки на месте (${file})`);
  }

  try {
    currentPlatform();
    const jobs = serviceStatus();
    const access = getAccess(readConfig());
    const needTunnel = access.mode === 'ssh' || access.mode === 'cloudflare';
    for (const j of jobs) {
      const isTunnel = /tunnel/.test(j.name);
      if (j.running) good(`Сервис ${j.name}: ${j.detail}`);
      else if (isTunnel && !needTunnel) info(`Сервис ${j.name}: ${j.detail} (для режима ${access.mode} не нужен)`);
      else bad(`Сервис ${j.name}: ${j.detail}`, 'Выполните «cremote service install».');
    }
  } catch (e) {
    info((e as Error).message);
  }

  const cfg = readConfig();
  const port = Number(process.env.CREMOTE_PORT) || cfg?.port || PORT;
  const h = await getHealth(port);
  if (h.ok) good(`Сервер отвечает на 127.0.0.1:${port} (версия ${h.version})`);
  else bad(`Сервер не отвечает на 127.0.0.1:${port}: ${h.error}`, 'Запустите «cremote service restart» или «cremote start».');
  if (!cfg?.passwordHash) bad('Пароль не задан', 'Выполните «cremote passwd».');

  const access = getAccess(cfg);
  console.log(`\nДоступ: ${access.mode}`);
  if (access.mode === 'ssh') {
    if (!access.ssh?.target) bad('SSH-адрес не задан в config.json');
    else {
      const t = testSsh(access.ssh.target, access.ssh.identityFile);
      if (t.ok) good(`SSH до ${access.ssh.target} работает`);
      else bad(`SSH до ${access.ssh.target} не работает${t.error ? `: ${t.error}` : ''}`, 'Проверьте ключ и адрес: ssh -o BatchMode=yes <адрес> true');
    }
  } else if (access.mode === 'cloudflare') {
    if (findBinary('cloudflared')) good('cloudflared найден');
    else bad('cloudflared не найден в PATH');
    if (!access.cloudflare?.token) bad('Токен Cloudflare не задан', 'Запустите «cremote setup».');
  } else if (access.mode === 'tailscale') {
    const ts = findTailscale();
    if (!ts) bad('tailscale не найден', 'Установите Tailscale: https://tailscale.com/download');
    else {
      const serve = spawnSync(ts, ['serve', 'status'], { encoding: 'utf8', timeout: 10_000 });
      const out = `${serve.stdout ?? ''}${serve.stderr ?? ''}`;
      const name = tailscaleDnsName(ts);
      if (serve.status === 0 && out.includes(String(port))) good(`tailscale serve проксирует на порт ${port}${name ? `: https://${name}` : ''}`);
      else bad('tailscale serve не настроен на этот порт', `Выполните: tailscale serve --bg http://127.0.0.1:${port}`);
    }
  } else info('Только локальный доступ: сервер слушает 127.0.0.1');

  console.log(fails ? `\nПроблем: ${fails}` : `\nВсё в порядке (cremote ${getVersion()})`);
  return fails ? 1 : 0;
}
