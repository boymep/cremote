import { hashPassword } from './auth.js';
import { CONFIG_PATH, ensureConfig, writeConfig } from './config.js';
import { installHooks, uninstallHooks } from './install.js';
import { readSecret } from './prompt.js';
import { serviceInstall, serviceRestart, serviceStatus, serviceUninstall } from './service.js';
import { getVersion } from './config.js';

const USAGE = `cremote — удалённое управление сессиями Claude Code

  cremote setup                          мастер настройки (пароль, доступ, хуки, сервисы)
  cremote start                          запустить сервер в этом терминале
  cremote passwd                         задать пароль
  cremote hooks install|uninstall        хуки в ~/.claude/settings.json (старые install/uninstall работают)
  cremote service install|uninstall|restart|status
                                         автозапуск: launchd (macOS) или systemd --user (Linux)
  cremote update [--check] [-y]          проверить и поставить новую версию (--check — только проверить)
  cremote doctor                         проверить установку
  cremote version                        версия
`;

async function passwd(): Promise<void> {
  const cfg = ensureConfig();
  const pass = await readSecret('Новый пароль: ');
  if (pass.length < 8) {
    console.error('Пароль должен быть не короче 8 символов');
    process.exit(1);
  }
  if (process.stdin.isTTY) {
    const again = await readSecret('Повторите пароль: ');
    if (again !== pass) {
      console.error('Пароли не совпадают');
      process.exit(1);
    }
  }
  writeConfig({ ...cfg, passwordHash: hashPassword(pass) });
  console.log(`Пароль сохранён в ${CONFIG_PATH}`);
}

function hooksCommand(action: string | undefined): void {
  if (action === 'install') {
    ensureConfig();
    const r = installHooks();
    console.log(`Хуки добавлены в ${r.file}${r.backup ? `\nРезервная копия: ${r.backup}` : ''}`);
  } else if (action === 'uninstall') {
    const r = uninstallHooks();
    console.log(`Хуки cremote удалены из ${r.file}${r.backup ? `\nРезервная копия: ${r.backup}` : ''}`);
  } else {
    process.stderr.write(USAGE);
    process.exit(1);
  }
}

function serviceCommand(sub: string | undefined, rest: string[]): void {
  const load = ![sub, ...rest].includes('--no-load');
  if (sub === 'install') {
    const r = serviceInstall(load);
    for (const f of r.files) console.log(`Установлен ${f}`);
    for (const h of r.hints) console.log(h);
  } else if (sub === 'uninstall') {
    for (const f of serviceUninstall(load)) console.log(`Удалён ${f}`);
  } else if (sub === 'restart') {
    const done = serviceRestart();
    if (!done.length) console.log('Сервисы не установлены. Выполните «cremote service install».');
    for (const n of done) console.log(`Перезапущен ${n}`);
  } else if (sub === 'status') {
    for (const j of serviceStatus()) console.log(`${j.running ? '✓' : '✗'} ${j.name}: ${j.detail}`);
  } else {
    process.stderr.write(USAGE);
    process.exit(1);
  }
}

/** Command table. */
const COMMANDS: Record<string, (sub: string | undefined, rest: string[]) => void | Promise<void>> = {
  setup: async () => (await import('./setup.js')).setup(),
  start: async () => {
    await (await import('./index.js')).startServer();
  },
  passwd: () => passwd(),
  hooks: (sub) => hooksCommand(sub),
  install: () => hooksCommand('install'),
  uninstall: () => hooksCommand('uninstall'),
  service: serviceCommand,
  doctor: async () => {
    process.exitCode = await (await import('./doctor.js')).doctor();
  },
  version: () => console.log(getVersion()),
  update: async (sub, rest) => (await import('./update.js')).updateCommand([...(sub ? [sub] : []), ...rest]),
};

async function main(argv: string[]): Promise<void> {
  const [cmd, sub, ...rest] = argv;
  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd === '--version' || cmd === '-v') return COMMANDS.version(undefined, []);
  const handler = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (!handler) {
    process.stderr.write(USAGE);
    process.exit(1);
  }
  await handler(sub, rest);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
