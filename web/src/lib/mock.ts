// Фейковый сервер для разработки UI без бэкенда: `npm run dev:mock` или `?mock` в dev.
import type { Accounts, ClientMessage, Message, Pending, ServerMessage, SessionInfo } from './protocol';
import type { Api, SocketLike } from './socket';

const now = Date.now();
const min = 60_000;

const sessions: SessionInfo[] = [
  {
    id: 'sess-vscode-1',
    cwd: '/Users/me/Projects/cremote',
    project: 'cremote',
    title: 'Добавить карточки разрешений в мобильный UI',
    mtime: now - 1 * min,
    status: 'working',
    source: 'vscode',
    open: true,
    openSince: now - 40 * min,
    activity: { since: now - 65_000, tool: 'Bash', hint: 'npm run build:web' },
    queued: [
      { id: 'q-mock-1', text: 'После сборки запусти ещё e2e-тесты', attachments: [], createdAt: now - 20_000 },
    ],
  },
  {
    id: 'sess-sdk-2',
    cwd: '/Users/me/Projects/cremote',
    project: 'cremote',
    title: 'Рефакторинг хуков',
    mtime: now - 25 * min,
    status: 'awaiting_input',
    source: 'sdk',
    permissionMode: 'acceptEdits',
  },
  {
    id: 'sess-vscode-5',
    cwd: '/Users/me/Projects/cremote',
    project: 'cremote',
    title: 'Ревью README перед релизом',
    mtime: now - 6 * min,
    status: 'awaiting_input',
    source: 'vscode',
    open: true,
    openGuess: true,
    openSince: now - 90 * min,
  },
  {
    id: 'sess-cli-3',
    cwd: '/Users/me/Projects/shop-frontend',
    project: 'shop-frontend',
    title: 'Почему падает сборка на CI после обновления vite',
    mtime: now - 3 * 60 * min,
    status: 'idle',
    source: 'cli',
  },
  {
    id: 'sess-hist-4',
    cwd: '/Users/me/Projects/shop-frontend',
    project: 'shop-frontend',
    title: 'Миграция на Svelte 5',
    mtime: now - 3 * 24 * 60 * min,
    status: 'history',
    source: 'vscode',
  },
];

// `?mock&pending=none` — чат без карточек: видна сама лента и панель ввода.
const noPending = new URLSearchParams(location.search).get('pending') === 'none';

let pending: Pending[] = noPending ? [] : [
  {
    id: 'perm-1',
    kind: 'permission',
    sessionId: 'sess-vscode-1',
    toolName: 'Bash',
    input: { command: 'npm run build && npm test -- --run', description: 'Собрать и прогнать тесты' },
    suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run build:*' }], behavior: 'allow', destination: 'localSettings' }],
    createdAt: now - 30_000,
  },
  {
    id: 'q-1',
    kind: 'question',
    sessionId: 'sess-vscode-1',
    createdAt: now - 20_000,
    questions: [
      {
        question: 'Где показывать карточки pending?',
        header: 'Раскладка',
        multiSelect: false,
        options: [
          { label: 'Над полем ввода', description: 'Закреплены внизу, всегда видны' },
          { label: 'В ленте', description: 'Как обычные сообщения' },
        ],
      },
      {
        question: 'Какие уведомления включить?',
        header: 'Уведомления',
        multiSelect: true,
        options: [{ label: 'Вибрация' }, { label: 'Звук' }, { label: 'Счётчик в заголовке' }],
      },
    ],
  },
];

let remote = true;

// Аккаунты: `?mock&accounts=error` — cswap упал, остаётся один аккаунт без лимитов;
// `?mock&accounts=exhausted` — у активного аккаунта 5-часовой лимит 100 %.
const accountsMode = new URLSearchParams(location.search).get('accounts');
const inH = (h: number) => new Date(now + h * 3_600_000).toISOString();
let accounts: Accounts | null =
  accountsMode === 'error'
    ? {
        activeNumber: null,
        fetchedAt: new Date(now - 4 * min).toISOString(),
        error: 'cswap не найден: ~/.local/bin/cswap',
        items: [{ number: null, email: 'me@example.com', org: 'Personal', active: true, usageStatus: 'unavailable', windows: [] }],
      }
    : {
        activeNumber: 1,
        fetchedAt: new Date(now - 2 * min).toISOString(),
        items: [
          {
            number: 1,
            email: 'me@example.com',
            alias: 'Основной Max',
            org: 'Demo User',
            active: true,
            usageStatus: 'ok',
            windows: [
              { id: 'fiveHour', label: '5 ч', pct: accountsMode === 'exhausted' ? 100 : 90, resetsAt: inH(2.17) },
              { id: 'sevenDay', label: '7 дней', pct: 65, resetsAt: inH(76) },
            ],
          },
          {
            number: 2,
            email: 'work.account.with.a.really.long.address@company-example.com',
            org: 'Company Example LLC',
            active: false,
            usageStatus: 'ok',
            windows: [
              { id: 'fiveHour', label: '5 ч', pct: 2, resetsAt: inH(4.6) },
              { id: 'sevenDay', label: '7 дней', pct: 99, resetsAt: inH(20) },
            ],
          },
          {
            number: 3,
            email: 'old@example.com',
            alias: 'Запасной',
            name: 'Рабочий Данила',
            active: false,
            disabled: true,
            usageStatus: 'ok',
            loginExpiresAt: inH(30),
            windows: [
              { id: 'fiveHour', label: '5 ч', pct: 0, resetsAt: null },
              { id: 'sevenDay', label: '7 дней', pct: 12, resetsAt: inH(130) },
            ],
          },
        ],
      };
let seq = 0;
const uid = () => `m-${++seq}`;
const ts = (offsetMin: number) => new Date(now - offsetMin * min).toISOString();

const TINY_IMG = btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#e9e4da"/><rect x="16" y="16" width="288" height="110" rx="10" fill="#fff"/><rect x="16" y="136" width="220" height="28" rx="14" fill="#d97757"/></svg>',
);

function sample(sessionId: string): Message[] {
  const s = sessions.find((x) => x.id === sessionId);
  const cwd = s?.cwd ?? '/Users/me/Projects/cremote';
  return [
    {
      uuid: uid(),
      role: 'user',
      timestamp: ts(12),
      isSidechain: false,
      blocks: [
        { kind: 'text', text: 'Сделай закреплённые карточки разрешений над полем ввода. Вот скриншот текущего вида.' },
        { kind: 'image', mediaType: 'image/svg+xml', data: TINY_IMG },
      ],
    },
    {
      uuid: uid(),
      role: 'assistant',
      timestamp: ts(11),
      isSidechain: false,
      blocks: [
        { kind: 'thinking', text: 'Нужно найти компонент ленты, потом добавить контейнер для карточек между лентой и композером. Проверю, как устроен layout.' },
        { kind: 'text', text: 'Посмотрю, как устроена страница сессии, и найду место для карточек.' },
        { kind: 'tool_use', id: 'tu-grep', name: 'Grep', input: { pattern: 'Composer', path: `${cwd}/web/src` } },
      ],
    },
    {
      uuid: uid(),
      role: 'user',
      timestamp: ts(11),
      isSidechain: false,
      blocks: [{ kind: 'tool_result', toolUseId: 'tu-grep', isError: false, text: 'web/src/lib/components/SessionView.svelte\nweb/src/lib/components/Composer.svelte' }],
    },
    {
      uuid: uid(),
      role: 'assistant',
      timestamp: ts(10),
      isSidechain: false,
      blocks: [{ kind: 'tool_use', id: 'tu-task', name: 'Task', input: { subagent_type: 'Explore', description: 'Найти стили layout', prompt: 'Find layout styles' } }],
    },
    {
      uuid: uid(),
      role: 'user',
      timestamp: ts(10),
      isSidechain: true,
      blocks: [{ kind: 'text', text: 'Find layout styles' }],
    },
    {
      uuid: uid(),
      role: 'assistant',
      timestamp: ts(10),
      isSidechain: true,
      blocks: [
        { kind: 'tool_use', id: 'tu-sc-read', name: 'Read', input: { file_path: `${cwd}/web/src/app.css` } },
      ],
    },
    {
      uuid: uid(),
      role: 'user',
      timestamp: ts(10),
      isSidechain: true,
      blocks: [{ kind: 'tool_result', toolUseId: 'tu-sc-read', isError: false, text: ':root {\n  --gutter: 16px;\n}\n' }],
    },
    {
      uuid: uid(),
      role: 'assistant',
      timestamp: ts(9),
      isSidechain: true,
      blocks: [{ kind: 'text', text: 'Стили лежат в `web/src/app.css`, отступ 16px.' }],
    },
    {
      uuid: uid(),
      role: 'user',
      timestamp: ts(9),
      isSidechain: false,
      blocks: [{ kind: 'tool_result', toolUseId: 'tu-task', isError: false, text: 'Стили лежат в web/src/app.css, отступ 16px.' }],
    },
    {
      uuid: uid(),
      role: 'assistant',
      timestamp: ts(8),
      isSidechain: false,
      blocks: [
        {
          kind: 'tool_use',
          id: 'tu-edit',
          name: 'Edit',
          input: {
            file_path: `${cwd}/web/src/lib/components/SessionView.svelte`,
            old_string: '<Feed {messages} />\n<Composer {session} />',
            new_string: '<Feed {messages} />\n<div class="pinned">\n  {#each pending as p (p.id)}\n    <PendingCard {p} />\n  {/each}\n</div>\n<Composer {session} />',
          },
        },
      ],
    },
    {
      uuid: uid(),
      role: 'user',
      timestamp: ts(8),
      isSidechain: false,
      blocks: [{ kind: 'tool_result', toolUseId: 'tu-edit', isError: false, text: 'The file has been updated.' }],
    },
    {
      uuid: uid(),
      role: 'assistant',
      timestamp: ts(7),
      isSidechain: false,
      blocks: [{ kind: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'npm run check', description: 'Проверка типов' } }],
    },
    {
      uuid: uid(),
      role: 'user',
      timestamp: ts(7),
      isSidechain: false,
      blocks: [
        {
          kind: 'tool_result',
          toolUseId: 'tu-bash',
          isError: true,
          text: "Error: src/lib/components/SessionView.svelte:14:5\nCannot find name 'PendingCard'. Did you forget to import it?\n\n1 error, 0 warnings",
        },
      ],
    },
    {
      uuid: uid(),
      role: 'assistant',
      timestamp: ts(6),
      isSidechain: false,
      blocks: [
        {
          kind: 'text',
          text: 'Проверка упала: забыл импорт. Исправлю:\n\n```ts\nimport PendingCard from \'./PendingCard.svelte\';\n```\n\nПосле этого запущу сборку. Ссылка для XSS-проверки: <img src=x onerror="alert(1)"> — должна быть обезврежена.',
        },
        { kind: 'tool_use', id: 'tu-write', name: 'Write', input: { file_path: `${cwd}/web/src/lib/pending.ts`, content: "export const PINNED_MAX = '50dvh';\nexport const BEEP = true;\n" } },
      ],
    },
    {
      uuid: uid(),
      role: 'user',
      timestamp: ts(6),
      isSidechain: false,
      blocks: [{ kind: 'tool_result', toolUseId: 'tu-write', isError: false, text: 'File created successfully' }],
    },
    {
      uuid: uid(),
      role: 'user',
      timestamp: ts(5),
      isSidechain: false,
      blocks: [{ kind: 'hook_feedback', text: 'И добавь вибрацию при новом запросе' }],
    },
    {
      uuid: uid(),
      role: 'user',
      timestamp: ts(5),
      isSidechain: false,
      blocks: [
        {
          kind: 'meta',
          sys: 'agent_report',
          summary: 'implementer: DONE. Карточки закреплены над полем ввода, проверки прошли.',
          body: '## Status\nDONE. Карточки закреплены над полем ввода, проверки прошли.\n\n## Changes\n- web/src/lib/components/SessionView.svelte:212 - контейнер .pinned\n\n## Evidence\n- npx svelte-check -> 0 errors, 0 warnings',
          text: 'Another Claude session sent a message:\n<agent-message from="a3a228a22a0989577">\n[Subagent hand-back] The text below is the final report of a subagent… The report follows:\n  ## Status\n  DONE.\n</agent-message>',
        },
      ],
    },
    {
      uuid: uid(),
      role: 'user',
      timestamp: ts(5),
      isSidechain: false,
      blocks: [
        {
          kind: 'meta',
          sys: 'task',
          status: 'completed',
          summary: 'Agent "Закрепить карточки разрешений" finished',
          body: 'Agent "Закрепить карточки разрешений" finished\n\nКарточки закреплены, сборка прошла.',
          text: '<task-notification>\n<task-id>a3a228a22a0989577</task-id>\n<tool-use-id>toolu_01KKHNPbG9DvRrb3bF3UTuqa</tool-use-id>\n<status>completed</status>\n<summary>Agent "Закрепить карточки разрешений" finished</summary>\n</task-notification>',
        },
      ],
    },
    {
      uuid: uid(),
      role: 'user',
      timestamp: ts(5),
      isSidechain: false,
      blocks: [{ kind: 'meta', sys: 'interrupt', text: '[Request interrupted by user]' }],
    },
    {
      uuid: uid(),
      role: 'assistant',
      timestamp: ts(5),
      isSidechain: false,
      blocks: [
        {
          kind: 'text',
          text:
            'Сабагент закончил. Вот итоговая функция — строки длинные, блок прокручивается вбок:\n\n```ts\nexport function vibrateOnPending(pending: PendingPermission[], previous: Set<string>, pattern: number[] = [40, 30, 40]): void {\n  const fresh = pending.filter((p) => !previous.has(p.id) && p.kind === \'permission\' && document.visibilityState === \'visible\');\n  if (fresh.length > 0 && \'vibrate\' in navigator) navigator.vibrate(pattern);\n}\n```\n\nОчень_длинный_идентификатор_без_пробелов_который_не_должен_расширять_экран_aaaaaaaaaaaaaaaaaaaaaaaaaaaa.',
        },
      ],
    },
    {
      uuid: uid(),
      role: 'assistant',
      timestamp: ts(4),
      isSidechain: false,
      blocks: [
        { kind: 'text', text: 'Хорошо. Добавлю `navigator.vibrate` и короткий звук. Сначала соберу проект — для этого нужно разрешение.' },
        { kind: 'tool_use', id: 'tu-bash2', name: 'Bash', input: { command: 'npm run build && npm test -- --run' } },
      ],
    },
  ];
}

const older = (): Message[] => [
  {
    uuid: uid(),
    role: 'user',
    timestamp: ts(60),
    isSidechain: false,
    blocks: [{ kind: 'text', text: 'Начнём с каркаса приложения.' }],
  },
  {
    uuid: uid(),
    role: 'assistant',
    timestamp: ts(59),
    isSidechain: false,
    blocks: [{ kind: 'text', text: 'Готово: **Vite + Svelte 5**, роутинг по hash.' }],
  },
];

const sockets = new Set<MockSocket>();

/**
 * Принудительное состояние связи: `?mock&conn=<режим>`.
 * connecting — сокет не открывается; reconnecting — связь пропадает после hello;
 * offline — то же плюс navigator.onLine=false; down — после hello туннель падает (/api/me → 502);
 * down-start — сервер недоступен с самого начала; login — экран входа
 * (пароль «ok» → вход, «429» → лимит попыток, «502» → сервер недоступен, иначе неверный пароль).
 */
export type MockConn = 'ok' | 'connecting' | 'reconnecting' | 'offline' | 'down' | 'down-start' | 'login';
const connParam = new URLSearchParams(location.search).get('conn');
export const mockConn: MockConn = (
  ['connecting', 'reconnecting', 'offline', 'down', 'down-start', 'login'] as const
).find((c) => c === connParam) ?? 'ok';
let dropped = false;
let loggedIn = false;

class MockSocket implements SocketLike {
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  private loadedOlder = new Set<string>();

  constructor() {
    sockets.add(this);
    if (mockConn === 'connecting') return;
    const breaks = mockConn === 'reconnecting' || mockConn === 'offline' || mockConn === 'down';
    if (mockConn === 'down-start' || (breaks && dropped)) {
      setTimeout(() => this.close(), 200);
      return;
    }
    if (breaks) {
      setTimeout(() => {
        dropped = true;
        this.close();
      }, 600);
    }
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.(new Event('open'));
      this.emit({ type: 'hello', remoteAccess: remote, sessions, pending, accounts });
    }, 150);
  }

  private emit(msg: ServerMessage) {
    if (this.readyState !== 1) return;
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(msg) }));
  }

  private later(msg: ServerMessage, ms = 120) {
    setTimeout(() => this.emit(msg), ms);
  }

  private broadcast(msg: ServerMessage, ms = 120) {
    for (const s of sockets) s.later(msg, ms);
  }

  send(data: string) {
    const m = JSON.parse(data) as ClientMessage;
    const ok = () => m.requestId && this.later({ type: 'ok', requestId: m.requestId });
    const err = (message: string) => this.later({ type: 'error', requestId: m.requestId, message });
    switch (m.type) {
      case 'subscribe':
        this.later({ type: 'messages', sessionId: m.sessionId, messages: sample(m.sessionId), mode: 'replace', hasMore: true }, 250);
        break;
      case 'load_more':
        ok();
        if (!this.loadedOlder.has(m.sessionId)) {
          this.loadedOlder.add(m.sessionId);
          this.later({ type: 'messages', sessionId: m.sessionId, messages: older(), mode: 'prepend', hasMore: false }, 500);
        }
        break;
      case 'set_remote':
        remote = m.enabled;
        ok();
        this.broadcast({ type: 'remote', enabled: remote });
        break;
      case 'answer_permission':
      case 'answer_question':
        pending = pending.filter((p) => p.id !== m.id);
        ok();
        this.broadcast({ type: 'pending', pending });
        break;
      case 'send_message': {
        const s = sessions.find((x) => x.id === m.sessionId);
        if (s && s.source !== 'sdk' && (s.status === 'live' || s.status === 'working')) {
          // Claude отвечает: сообщение встаёт в очередь и уйдёт после ответа.
          s.queued = [...(s.queued ?? []), { id: `q-${Date.now()}`, text: m.text, attachments: m.attachments, createdAt: Date.now() }];
          if (m.requestId) this.later({ type: 'ok', requestId: m.requestId, queued: true });
          this.broadcast({ type: 'sessions', sessions: [...sessions] });
          break;
        }
        if (s && s.source !== 'sdk' && s.status === 'idle' && s.open) {
          err('Сессия ждёт ввода в VS Code');
          break;
        }
        ok();
        const user: Message = {
          uuid: uid(),
          role: 'user',
          timestamp: new Date().toISOString(),
          isSidechain: false,
          blocks: [{ kind: s?.source === 'sdk' ? 'text' : 'hook_feedback', text: m.text || '(картинка)' }],
        };
        this.later({ type: 'messages', sessionId: m.sessionId, messages: [user], mode: 'append', hasMore: true }, 300);
        if (s) {
          s.status = 'working';
          this.broadcast({ type: 'sessions', sessions: [...sessions] }, 400);
        }
        this.later(
          {
            type: 'messages',
            sessionId: m.sessionId,
            mode: 'append',
            hasMore: true,
            messages: [
              {
                uuid: uid(),
                role: 'assistant',
                timestamp: new Date().toISOString(),
                isSidechain: false,
                blocks: [{ kind: 'text', text: `Принял: «${m.text}». Это ответ мока.` }],
              },
            ],
          },
          1500,
        );
        setTimeout(() => {
          if (s) {
            s.status = 'awaiting_input';
            this.broadcast({ type: 'sessions', sessions: [...sessions] }, 0);
          }
        }, 1800);
        break;
      }
      case 'interrupt': {
        ok();
        const s = sessions.find((x) => x.id === m.sessionId);
        if (s) {
          s.status = s.source === 'sdk' ? 'idle' : 'awaiting_input';
          this.broadcast({ type: 'sessions', sessions: [...sessions] }, 600);
        }
        break;
      }
      case 'set_mode': {
        const s = sessions.find((x) => x.id === m.sessionId);
        if (s) s.permissionMode = m.mode;
        ok();
        this.broadcast({ type: 'sessions', sessions: [...sessions] });
        break;
      }
      case 'switch_account': {
        const target = m.number;
        setTimeout(() => {
          if (!accounts) return;
          const found = accounts.items.some((a) => a.number === target);
          if (!found) {
            err(`Аккаунт ${target} не найден`);
            return;
          }
          accounts = {
            ...accounts,
            activeNumber: target,
            fetchedAt: new Date().toISOString(),
            items: accounts.items.map((a) => ({ ...a, active: a.number === target })),
          };
          this.broadcast({ type: 'accounts', accounts }, 0);
          ok();
        }, 1500);
        break;
      }
      case 'cancel_queued': {
        const s = sessions.find((x) => x.id === m.sessionId);
        if (!s?.queued?.some((q) => q.id === m.id)) {
          err('Сообщение уже отправлено');
          break;
        }
        s.queued = s.queued.filter((q) => q.id !== m.id);
        ok();
        this.broadcast({ type: 'sessions', sessions: [...sessions] });
        break;
      }
      case 'refresh_accounts':
        setTimeout(() => {
          if (accounts) accounts = { ...accounts, fetchedAt: new Date().toISOString() };
          this.broadcast({ type: 'accounts', accounts }, 0);
          ok();
        }, 600);
        break;
      case 'create_session': {
        ok();
        const id = `sess-new-${Date.now()}`;
        const parts = m.cwd.split('/');
        sessions.unshift({
          id,
          cwd: m.cwd,
          project: parts[parts.length - 1] || m.cwd,
          title: m.text.slice(0, 80) || 'Новая сессия',
          mtime: Date.now(),
          status: 'working',
          source: 'sdk',
          permissionMode: m.permissionMode,
        });
        this.broadcast({ type: 'sessions', sessions: [...sessions] }, 900);
        break;
      }
      default:
        ok();
    }
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    sockets.delete(this);
    this.onclose?.(new CloseEvent('close'));
  }
}

export function mockSocketFactory(): SocketLike {
  return new MockSocket();
}

let uploadSeq = 0;

export const mockApi: Api = {
  async me() {
    await new Promise((r) => setTimeout(r, 50));
    if (mockConn === 'login' && !loggedIn) return 401;
    if (mockConn === 'down-start' || (mockConn === 'down' && dropped)) return 502;
    if (mockConn === 'offline' && dropped) return 0;
    return 200;
  },
  async login(password) {
    await new Promise((r) => setTimeout(r, 200));
    if (password === 'ok') {
      loggedIn = true;
      return 200;
    }
    return password === '429' ? 429 : password === '502' ? 502 : 401;
  },
  async logout() {},
  async projects() {
    return ['/Users/me/Projects/cremote', '/Users/me/Projects/shop-frontend', '/Users/me/Projects/dotfiles'];
  },
  async models() {
    await new Promise((r) => setTimeout(r, 300));
    return [
      { value: 'default', displayName: 'Default (recommended)', description: 'Opus для Max, Sonnet для Pro' },
      { value: 'opus', displayName: 'Opus', description: 'Самая сильная модель для сложных задач' },
      { value: 'sonnet', displayName: 'Sonnet', description: 'Быстрая модель для повседневной работы' },
      { value: 'haiku', displayName: 'Haiku', description: 'Самая быстрая модель для простых задач' },
    ];
  },
  async upload(file) {
    await new Promise((r) => setTimeout(r, 600));
    const id = `up-${++uploadSeq}`;
    return { id, path: `/Users/me/.cremote/uploads/${id}`, mediaType: file.type };
  },
};
