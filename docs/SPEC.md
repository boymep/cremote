# cremote — спецификация

Веб-приложение для телефона. Через него можно смотреть сессии Claude Code на Mac и управлять ими, в том числе сессиями из расширения VS Code.

## Архитектура

```
Телефон ──HTTPS──▶ example.com (nginx на VPS)
                        │ proxy_pass http://127.0.0.1:3010 (WebSocket upgrade)
                        ▼
                  обратный SSH-туннель  (ssh -N -R 127.0.0.1:3010:127.0.0.1:7878)
                        ▼
Mac: сервер cremote 127.0.0.1:7878
   ├─ читает ~/.claude/projects/**/*.jsonl (история и живой хвост)
   ├─ принимает хуки Claude Code (/hook/*) от hooks/cremote-hook.mjs
   └─ запускает новые сессии через @anthropic-ai/claude-agent-sdk
```

- Монорепозиторий без workspaces. В корне лежит сервер (`server/`) и `package.json`. В `web/` — Svelte 5 + Vite со своим `package.json`.
- Сервер отдаёт собранный `web/dist` как статику и обслуживает WebSocket на `/ws`.
- Данные лежат в `~/.cremote/`: `config.json` (права 600), `state.json` и `uploads/`.
- Порт берётся из `CREMOTE_PORT`, по умолчанию 7878. Хост берётся из `CREMOTE_HOST`, по умолчанию `127.0.0.1`. Чтобы открыть доступ из локальной сети, укажите `0.0.0.0`.

## Безопасность

- Пароль задаётся командой `cremote passwd`. Сервер хранит scrypt-хеш в `config.json`.
- `POST /api/login {password}` выдаёт cookie `cremote_session`: случайные 32 байта, `HttpOnly`, `SameSite=Strict`, `Path=/`, срок 30 дней. Флаг `Secure` ставится, если запрос пришёл с `X-Forwarded-Proto: https`.
- Сессии входа хранятся в `state.json`, поэтому переживают перезапуск сервера.
- Попытки входа ограничены: не больше 5 неудачных за 15 минут с одного IP. IP берётся из `X-Real-IP`, если запрос пришёл с loopback. Иначе берётся адрес сокета.
- Все `/api/*`, кроме `login`, и `/ws` требуют cookie. WebSocket дополнительно проверяет `Origin`: он должен совпадать с `Host`.
- `/hook/*` принимает запросы только с loopback и только с заголовком `X-Cremote-Hook: <hookSecret>`. Секрет лежит в `config.json`. Проверка обязательна: запросы из туннеля тоже приходят с loopback. Nginx дополнительно отвечает 404 на `/hook/`.
- `POST /api/logout` удаляет сессию.

## Хуки (сессии VS Code и CLI)

`cremote install` дописывает хуки в `~/.claude/settings.json`. Перед этим он сохраняет резервную копию `settings.json.cremote-backup-<ts>`. Каждая запись помечается: команда содержит `cremote-hook.mjs`. Поэтому `cremote uninstall` удаляет только свои записи. В `env` добавляется `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=10000`.

Все хуки имеют вид `{"type":"command","command":"node <abs>/hooks/cremote-hook.mjs <Event>","timeout":N}`. В группах SessionStart и Stop есть второй хук — `Wait`: `{"type":"command","command":"node <abs>/hooks/cremote-hook.mjs Wait","timeout":604800,"async":true,"asyncRewake":true}`.

| Событие | matcher | timeout | Назначение |
|---|---|---|---|
| SessionStart | — | 5 | сессия жива; плюс async `Wait` |
| SessionEnd | — | 5 | сессия закрыта |
| UserPromptSubmit | — | 5 | статус `working` |
| Notification | — | 5 | показать уведомление |
| PermissionRequest | `*` | 86400 | разрешение и AskUserQuestion с телефона |
| PreToolUse | `*` | 86400 | прерывание |
| PostToolUse | `*` | 5 | снять карточку; отдать очередь посреди ответа |
| Stop | — | 10 | отдать очередь; плюс async `Wait` |
| `Wait` (async, asyncRewake) | — | 604800 | разбудить простаивающую сессию сообщением с телефона |

Ни один хук не держит сессию ради сообщений с телефона. Долго ждать может только PermissionRequest — это карточки разрешений и вопросов.

`hooks/cremote-hook.mjs` — скрипт без зависимостей. Он читает JSON из stdin, читает `~/.cremote/config.json` (port и hookSecret) и делает `POST http://127.0.0.1:<port>/hook/<Event>` с телом из stdin и заголовком `X-Cremote-PPID` (pid родителя скрипта). Ответ сервера (JSON) он печатает в stdout и выходит с кодом 0. Если сервер недоступен или ответил не 2xx, скрипт сразу выходит с кодом 0 и ничего не печатает. Для Claude Code это значит «хука нет».

`Wait` — не событие Claude Code, а режим скрипта. Claude Code запускает его в фоне на SessionStart и Stop и не ждёт его. Скрипт держит запрос `POST /hook/Wait` к серверу:

- ответ `{"wake":"<текст>"}` — скрипт пишет текст в stderr и выходит с кодом 2. Claude Code с `asyncRewake` начинает новый ход с этим текстом, даже если сессия простаивает;
- ответ `{}` — скрипт выходит с кодом 0 молча;
- обрыв соединения (сервер перезапустился) — повтор через 5 с;
- раз в 2 с скрипт проверяет родителя. Если процесс Claude Code исчез, скрипт выходит с кодом 0.

`asyncRewake` проверен на стенде через Agent SDK со streaming input, как в VS Code. Async-хук тоже подчиняется `timeout`: с `timeout: 3` его убивают, поэтому у `Wait` неделя. Claude Code показывает модели такой ход как `<task-notification>` «Stop hook feedback» с пометкой `[SYSTEM NOTIFICATION - NOT USER INPUT]`: «не считать подтверждением». Поэтому Claude выполняет просьбу с телефона, но не принимает её как согласие на то, что он сам предложил спросить. Например, на «да, создай файл» он ответил, что ответ пришёл не от пользователя. Для согласия используйте карточки разрешений.

Поведение сервера по событиям. Пустой ответ — это `{}`.

**Телефон рядом.** Писать можно и с телефона, и в VS Code. Переключателя нет. Телефон «рядом», если сейчас подключён хотя бы один авторизованный WS-клиент или последний отключился меньше 30 минут назад. Срок задаёт `phonePresenceMs` в `config.json`. Присутствие влияет только на карточки PermissionRequest: без телефона хук сразу отвечает `{}`, а когда срок истекает, карточки хуков снимаются. На доставку сообщений присутствие не влияет: она ничего не блокирует.

**Текст сообщения для Claude.** Сообщения из очереди склеиваются через `"\n\n---\n\n"`, перед ними стоит `"The user sent a message from their phone (cremote):\n\n"`. Если приложены картинки, к тексту добавляется `"\n\n[Attached images — open them with the Read tool: /abs/path1, /abs/path2]"`. Очередь очищается при отдаче.

- **SessionStart / SessionEnd / UserPromptSubmit / Notification.** Сервер обновляет статус сессии (`live`, `working`, `idle`, `ended`) и сразу отвечает `{}`. SessionStart с `source:"compact"` статус не меняет. UserPromptSubmit и SessionEnd отпускают `Wait` этой сессии с `{}`. UserPromptSubmit приходит и на ход, начатый `asyncRewake` или фоновой задачей.
- **PostToolUse.** Снимает pending-карточки разрешений этой сессии с тем же `tool_use_id` или с тем же `tool_name` и `tool_input`, а для `AskUserQuestion` — карточку вопроса. Это нужно, когда на запрос ответили в VS Code: Claude Code не всегда убивает процесс хука. Если в очереди есть сообщения, сервер отдаёт их посреди ответа: `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"<текст>"}}`. Claude видит это как system-reminder сразу после результата инструмента. Вызовы внутри субагента (во входе есть `agent_id`) пропускаются: сообщение должно попасть к главному агенту.
- **PermissionRequest.** Если телефона рядом нет, сервер сразу отвечает `{}`. Иначе он создаёт pending и ждёт ответа. Claude Code показывает свой диалог в VS Code одновременно с хуком, поэтому побеждает тот, кто ответит первым. Если первым ответили в VS Code, Claude Code убивает процесс хука или присылает PostToolUse, и карточка снимается.
  - Обычный инструмент: pending `permission` с полями `id`, `sessionId`, `toolName`, `input`, `suggestions` (`permission_suggestions` из входа, если есть). Ответ: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions"?}}}` или `{... "decision":{"behavior":"deny","message":"..."}}`.
  - `AskUserQuestion`: pending `question` с полями `id`, `sessionId`, `questions`. Ответ: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"questions":[...],"answers":{"<question>":"<label или текст; для multiSelect — метки через \", \">"}}}}}`. PermissionRequest для `AskUserQuestion` проверен на стенде: stream-json и stdio-диалог разрешений, как в VS Code.
- **PermissionDenied.** Claude Code шлёт его только в auto-режиме, когда классификатор заблокировал вызов (вход: `tool_name`, `tool_input`, `tool_use_id`, `reason`). Без телефона сервер отвечает `{}`. Иначе он создаёт pending `permission` с `blocked: true` и `reason` (карточка «Заблокировано классификатором», кнопки «Разрешить» и «Отклонить», «Разрешить всегда» нет) и шлёт push, как для обычной карточки. «Разрешить»: сервер запоминает одноразовое одобрение `{sessionId, tool_name, stable-stringify(tool_input)}` на 10 минут и отвечает `{"hookSpecificOutput":{"hookEventName":"PermissionDenied","retry":true}}`: модель может повторить вызов. «Отклонить» или закрытие хука: `{}`. Хук в `settings.json`: matcher `*`, timeout 86400.
- **PreToolUse.** Если прерывания нет и вызов точно совпадает с одобрением из PermissionDenied (та же сессия, `tool_name`, `tool_input`), одобрение расходуется и сервер отвечает `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Approved by the user from phone (cremote) after classifier block"}}`. Совпадение только точное. **Не проверено:** обходит ли `allow` из PreToolUse сам классификатор (проверить вживую). SDK-сессии (`canUseTool`) этим потоком не покрыты, если они не грузят пользовательские хуки.
  1. Если у сессии стоит флаг `interruptRequested`, сервер сбрасывает его и отвечает `permissionDecision:"deny"` с причиной `"The user pressed Stop from the cremote remote. Stop working now: do not call more tools, briefly say where you stopped, and wait for the next instruction."`.
  2. В остальных случаях сервер отвечает `{}`.
- **Stop.** Никогда не ждёт. Если в очереди есть сообщения, сервер ставит `working` и отвечает `{"decision":"block","reason":"<текст>"}`. Так сообщение, отправленное во время ответа без инструментов, уходит в конце ответа. Иначе статус `idle` и ответ `{}`.
- **Wait.** Сервер запоминает хук как «будильник» сессии. Новый `Wait` той же сессии отпускает старый с `{}`. Если сессия не `working` и в очереди уже есть сообщения, сервер отвечает сразу. Иначе он ждёт `send_message`, UserPromptSubmit, SessionEnd или закрытия соединения.
- **Ввод в VS Code и фоновые уведомления.** Хуки сообщений ничего не держат, поэтому ввод в VS Code и `<task-notification>` от фоновых задач и агентов Claude Code обрабатывает сразу. Хук `Wait` отпускается по UserPromptSubmit, следующий Stop запускает новый.

## Сессии через Agent SDK

- `create_session {cwd, text, attachments, permissionMode, model?}` запускает `query()` в режиме streaming input: `prompt` — это AsyncIterable с очередью. Картинки передаются блоками `{type:"image",source:{type:"base64",media_type,data}}`.
- `canUseTool` создаёт pending `permission`. Для `AskUserQuestion` он создаёт pending `question` и возвращает `{behavior:"allow", updatedInput:{questions, answers}}`.
- `send_message` кладёт сообщение в очередь. `interrupt` вызывает `query.interrupt()`. `set_mode` вызывает `query.setPermissionMode()`.
- `session_id` берётся из первого сообщения `system/init`. После этого сессия появляется в списке как `source:"sdk"`.
- Старую сессию, у которой нет живого процесса, можно продолжить через SDK. `send_message` запускает `query({resume: sessionId})`, если статус сессии `ended` или `history`. SDK-сессия без живого процесса тоже продолжается так.
- Сообщение в живую hook-сессию (статус `working`, `live`, `idle` или `awaiting_input`) сервер кладёт в очередь сессии. Очередь хранится в `state.json`. Если сессия не `working` и у неё есть `Wait`, сервер сразу отдаёт очередь в него и отвечает `ok` без `queued`: Claude просыпается. Иначе ответ `ok` с `queued: true`, и очередь уходит с ближайшим PostToolUse главного агента или со Stop. Вкладка, открытая до установки `Wait`, без него получит очередь только после следующего ввода в VS Code. Если вкладка открыта, но хуки о ней ничего не сообщали (статус `history`), сервер отвечает ошибкой с советом перезагрузить окно VS Code. SDK-сессии ставят сообщения в очередь сами.
- Защита от двойного запуска. Сессию, у которой есть процесс Claude Code (`open: true`), сервер не продолжает: «Сессия открыта в VS Code или терминале. Напишите там или закройте её.»
- Если процесса нет, сессию не из SDK (`vscode`, `cli`, `unknown`) со статусом не `ended` сервер не продолжает, пока её `.jsonl` или события хуков моложе 2 минут: «Сессия только что менялась. Подождите 2 минуты.» Если в той же папке работает процесс Claude, который не удалось сопоставить с сессией, окно — 15 минут и текст «Сессия, возможно, ещё открыта в VS Code. Закройте её там или подождите 15 минут.»
- В остальных случаях сервер возвращает ошибку с понятным текстом.
- Сообщения для отображения сервер всегда берёт из `.jsonl`, одинаково для всех источников.

## Транскрипты

- Сервер сканирует `~/.claude/projects/*/*.jsonl` (только верхний уровень), а также учитывает `CLAUDE_CONFIG_DIR`. `fs.watch` с повторным сканированием раз в 3 с подхватывает новые файлы.
- Для каждой сессии сервер хранит: `id` (имя файла), `cwd` (поле `cwd` из записей), `title`, `mtime`, `status` и `source` (`"vscode" | "cli" | "sdk" | "unknown"`; по полю `entrypoint` записи, если оно есть, иначе `"unknown"`).
- `title` выбирается так: последняя запись `custom-title` или `summary`, если есть. Иначе первые 80 символов первого текстового сообщения пользователя, без `<command-…>`, `<system-reminder>` и похожих тегов.
- Живой хвост: подписанным клиентам сервер дочитывает файл от сохранённого offset при изменении. Неполная последняя строка ждёт следующего чтения.
- Нормализация: каждая запись `type` `user` или `assistant` превращается в `Message {uuid, role, timestamp, blocks: Block[], isSidechain}`. Блоки:
  - `{kind:"text", text}`
  - `{kind:"thinking", text}`
  - `{kind:"image", mediaType, data}` — только для user. Base64 больше 2 МБ заменяется плейсхолдером.
  - `{kind:"tool_use", id, name, input}`
  - `{kind:"tool_result", toolUseId, isError, text}` — text обрезается до 20 000 символов.
  - `{kind:"hook_feedback", text}` — сообщение с телефона, которое пришло через хук: причина Stop, ход `Wait` (`<task-notification>` с текстом после `"The user sent a message from their phone (cremote):"`) или `attachment` типа `hook_additional_context` от PostToolUse.
  - `{kind:"meta", text, sys?, summary?, body?, status?}` — служебные записи, которые вставил Claude Code, а не человек. `text` — исходный текст. `sys` — тип:
    - `agent_report` — отчёт сабагента (`Another Claude session sent a message:` + `[Subagent hand-back]`). `body` — текст отчёта без рамки (из `origin.handbackReportText` или между `The report follows:` и `</agent-message>`, без отступа в два пробела). `summary` — `<имя агента>: <первая строка отчёта>`.
    - `agent_message` — сообщение другой сессии без отчёта.
    - `task` — `<task-notification>`. `summary` — из `<summary>`, `status` — из `<status>`, `body` — summary и `<result>`.
    - `command` — `<command-name>` или `<local-command-stdout|stderr>`; `summary` — команда или первая строка вывода.
    - `interrupt` — `[Request interrupted by user…]`.
    - `notice` — остальное: `<system-reminder>`, `[SYSTEM NOTIFICATION - NOT USER INPUT]`, `isMeta`-записи, плейсхолдер большой картинки.
    `summary` — одна строка до 140 символов, без markdown-заголовков. `<local-command-caveat>` и `Caveat: The messages below…` пропускаются. Остальные типы записей пропускаются.
- Неизвестные поля игнорируются, битые строки пропускаются. Формат внутренний и может меняться.
- При подписке отдаются последние 300 сообщений. Более старые запрашиваются через `load_more {sessionId, before: uuid}`.

## Открытые сессии

Сессия открыта (`open: true`), если для неё работает процесс Claude Code: вкладка Claude в VS Code или `claude` в терминале. `openSince` — время старта процесса в мс.

- Сервер раз в 5 с вызывает `ps -axo pid,ppid,lstart,command`, пока подключён хотя бы один WS-клиент. Ещё один проход идёт на каждое событие хука. Процессы Claude — это `…/claude` (нативный бинарник, в том числе из расширения VS Code) и `node …/claude` или `node …/@anthropic-ai/claude-code/cli.js`. Собственные SDK-процессы сервера не учитываются: их ведёт сам сервер, и такие сессии всегда `open`.
- Сопоставление процесса с сессией, по убыванию надёжности:
  1. Хук. Сервер поднимается от `X-Cremote-PPID` по цепочке родителей до процесса Claude и запоминает, что этот pid сейчас ведёт эту сессию. Побеждает последнее событие: после `/clear` или `/resume` во вкладке старая сессия теряет pid.
  2. `--resume <id>`, `--resume=<id>` или `--session-id <id>` в аргументах процесса.
  3. Догадка (`openGuess: true`). Сервер берёт папку процесса (`lsof -d cwd`, кешируется на pid) и ищет транскрипт с тем же `cwd`, изменённый после старта процесса. Догадка принимается, только если кандидат один и на него не претендует другой процесс.
- Когда процесс сессии исчезает, `open` становится `false`, а статус `live`, `working`, `idle` или `awaiting_input` меняется на `ended`. Так же сервер поступает после перезапуска с восстановленными статусами. Исключение — папки, где работает несопоставленный процесс Claude: там статус не трогается.
- Сопоставления хранятся в памяти. После перезапуска сервер снова опирается на аргументы и догадку, пока не придут события хуков.

## WebSocket `/ws`

Сервер → клиент:
- `{type:"hello", sessions: SessionInfo[], pending: Pending[], accounts: Accounts | null}`
- `{type:"sessions", sessions}` — при изменениях, с debounce 500 мс
- `{type:"pending", pending: Pending[]}` — полный список при каждом изменении
- `{type:"messages", sessionId, messages, mode:"replace"|"append"|"prepend", hasMore}`
- `{type:"notify", sessionId, title, message}`
- `{type:"accounts", accounts: Accounts | null}` — после каждого обновления (см. «Аккаунты и лимиты»)
- `{type:"error", requestId?, message}` и `{type:"ok", requestId, ...}`. Для `send_message` в очередь `ok` несёт `queued: true`, для `create_session` — `sessionId`.

`SessionInfo = {id, cwd, project (basename cwd), title, mtime, status:"live"|"working"|"idle"|"awaiting_input"|"ended"|"history", source, permissionMode?, open, openGuess?, openSince?, queued?, activity?}`. `activity = {since, tool?, hint?, writing?}` — что Claude делает в текущем ходе; есть только при статусе `working`. `since` — начало хода, мс. `tool` и `hint` (команда, имя файла или шаблон, до 40 символов) есть, пока выполняется инструмент: от PreToolUse до PostToolUse (у SDK-сессий — от `tool_use` до `tool_result`). `writing: true` у SDK-сессии значит, что Claude пишет текст ответа. Вызовы внутри субагентов не учитываются. Поле не сохраняется в `state.json`. Сервер рассылает его с обычным обновлением `sessions` только при изменении. `queued` — очередь сообщений с телефона: `[{id, text, attachments: string[], createdAt}]`. Поля нет, если очередь пуста. Статус `history` значит, что хуки о сессии ничего не сообщали. Статусы от хуков и время последнего события хука сервер хранит в `state.json` и восстанавливает при запуске. Статус `awaiting_input` восстанавливается как `idle`: процесс Stop-хука после перезапуска уже не ждёт. Статус `working` остаётся до следующего события хука.

`Pending = {id, kind:"permission", sessionId, toolName, input, suggestions?, createdAt} | {id, kind:"question", sessionId, questions, createdAt}`.

Клиент → сервер. Каждое сообщение может нести `requestId`.
- `subscribe {sessionId}` и `unsubscribe {sessionId}`
- `load_more {sessionId, before}`
- `set_remote {enabled}` — устарело. Сервер принимает его и ничего не делает.
- `answer_permission {id, behavior:"allow"|"deny", message?, updatedPermissions?}`
- `answer_question {id, answers: Record<string,string>}`
- `send_message {sessionId, text, attachments: string[]}` — это id загрузок
- `cancel_queued {sessionId, id}` — убрать сообщение из очереди. Если его уже отправили, ответ — ошибка «Сообщение уже отправлено».
- `interrupt {sessionId}`. Для SDK вызывается `interrupt()`. Для хуков ставится `interruptRequested`. Если сессия `idle`, ничего не происходит.
- `create_session {cwd, text, attachments, permissionMode:"default"|"acceptEdits"|"plan"|"bypassPermissions"|"dontAsk"|"auto", model?}`. Без `model` используется модель аккаунта по умолчанию.
- `set_mode {sessionId, mode}` — только для SDK-сессий
- `switch_account {number}` — переключить аккаунт Claude
- `refresh_accounts {}` — обновить аккаунты и лимиты сейчас

HTTP:
- `POST /api/upload` — сырое тело с `Content-Type: image/*`, не больше 10 МБ. Файл сохраняется в `~/.cremote/uploads/<id>.<ext>`. Ответ: `{id, path, mediaType}`.
- `GET /api/projects` — уникальные `cwd` из транскриптов, отсортированные по свежести.
- `GET /api/me` — 200 или 401.
- `GET /api/accounts` — объект `Accounts` (нужен cookie).
- `GET /api/models` — модели для новой сессии: `[{value, displayName, description}]` (нужен cookie). Список берётся из `supportedModels()` SDK: у живой SDK-сессии или у короткого запроса без промпта. Сервер кэширует его до перезапуска. Если SDK не ответил, сервер отдаёт запасной список алиасов `default`, `opus`, `sonnet`, `haiku` и пробует снова не раньше чем через 5 минут.

Клиент → сервер, presence для push: `{type:"presence", visible: boolean}`. Клиент шлёт его при открытии WS и при каждом `visibilitychange`. Пока хотя бы один клиент сообщает `visible:true`, сервер не шлёт push. Новое соединение считается невидимым, пока не пришло сообщение.

## Web Push (сервер)

Реализован на `node:crypto` без зависимостей (`server/src/push.ts`): VAPID (ES256, `sub` = `vapidSubject` из конфига, по умолчанию `mailto:cremote@example.com`, JWT на 12 ч), шифрование aes128gcm (RFC 8291). Ключи VAPID лежат в `~/.cremote/vapid.json` (0600), подписки — в `state.json` (`pushSubscriptions`).

API (после проверки cookie): `GET /api/push/key` → `{publicKey}`; `POST /api/push/subscribe {subscription}`; `POST /api/push/unsubscribe {endpoint}`; `POST /api/push/test`. Ответ 404/410 от push-сервиса удаляет подписку.

Payload: `{title, body, tag?, url?, badge?}`; `title` — имя проекта, `url` — `/#/s/<sessionId>`, `badge` — число ожидающих запросов.

Триггеры (не чаще одного push на `tag` за 10 с, и не при `visible:true`):
- новый запрос разрешения (`perm-<sessionId>`, Urgency high) — «Нужно разрешение: <tool> — <команда/файл>»;
- новый вопрос (`perm-<sessionId>`, Urgency high) — «Claude задаёт вопрос»;
- конец всей работы (`done-<sessionId>`), если от первого хода цепочки прошло больше 20 с — текст последнего сообщения Claude, до 200 символов, без разметки Markdown;
- хук `Notification` (`note-<sessionId>`), кроме `idle_prompt` — если за последние 15 с не было push по запросу той же сессии.

Конец работы — это 8 с тишины после Stop или конца хода SDK, когда в транскрипте нет незавершённых фоновых задач. Задача считается работающей от запуска (`async_launched`, `backgroundTaskId`) до `<task-notification>`. Погибшая задача уведомления не присылает, поэтому ожидание ограничено: агент — 60 мин от запуска, фоновая команда — 10 мин. Таймеры живут в памяти, и перезапуск сервера их сбрасывает. Ошибки SDK идут через `notify`.

## Аккаунты и лимиты

Источник данных — CLI `cswap` пользователя. Путь по умолчанию — `~/.local/bin/cswap`, его можно переопределить полем `cswapPath` в `config.json`. Сервер запускает его с расширенным `PATH`: у launchd в `PATH` нет `~/.local/bin`.

```
Accounts = {activeNumber, fetchedAt, items: AccountItem[], error?}
AccountItem = {number, email, org?, alias?, name?, active, disabled?, usageStatus,
               windows: [{id:"fiveHour"|"sevenDay", label:"5 ч"|"7 дней", pct, resetsAt}],
               loginExpiresAt?}
```

- Данные берутся из `cswap list --json`. Сервер копирует только перечисленные поля, токены наружу не попадают.
- Опрос раз в 60 с, только пока подключён хотя бы один WS-клиент. Без клиентов сервер cswap не запускает.
- После события Stop сервер обновляет данные с задержкой, не чаще раза в 20 с.
- Сервер следит за `~/.claude.json`. Если там сменился `oauthAccount` (аккаунт переключили в VS Code), он сразу обновляет данные. Обычные записи в файл обновление не запускают.
- `refresh_accounts` и `GET /api/accounts` обновляют данные не чаще раза в 10 с. В остальное время отдаётся последний результат.
- `switch_account {number}` запускает `cswap switch <number> --json` с таймаутом 120 с. Потом сервер обновляет список и отвечает `ok` или `error` с текстом на русском. Claude Code подхватывает новый аккаунт примерно за 30 с. Если переоткрыть вкладку Claude, аккаунт меняется сразу.
- `name` — отображаемое имя из общего файла `~/.config/claude-accounts/names.json` (его пишет расширение VS Code): `{"version":1,"names":{"<email>":"<имя>"}}`. Сопоставление по email: точное, затем без учёта регистра. Нет файла или он битый — имён нет. Путь можно переопределить переменной `CREMOTE_ACCOUNT_NAMES`. Сервер следит за каталогом файла (дебаунс 300 мс, наблюдатель создаётся лениво, если каталога нет — повтор на каждом опросе) и рассылает аккаунты заново без вызова cswap. Имя применяется и к запасному списку при ошибке cswap.
- Два процесса cswap одновременно не запускаются: вызовы идут в очередь.
- Если cswap не найден или упал, `accounts.error` содержит причину. В `items` тогда один активный аккаунт из `oauthAccount` в `~/.claude.json`: только email и организация, без лимитов, `usageStatus:"unavailable"`.

## CLI (`bin/cremote`)

- `cremote setup` — мастер: проверяет Node >= 20 и `claude` (PATH, `~/.local/bin`, `~/.claude/local`, nvm) и вход в Claude, задаёт пароль, выбирает режим доступа и его параметры, ставит хуки и сервисы, печатает адрес. Можно запускать повторно: текущие значения подставляются по умолчанию.
- `cremote start` — запустить сервер.
- `cremote passwd` — задать пароль (ввод без эха). Команда создаёт `config.json` и `hookSecret`, если их ещё нет.
- `cremote hooks install|uninstall` — хуки (см. выше). Старые `cremote install` и `cremote uninstall` работают как псевдонимы.
- `cremote service install|uninstall|restart|status` — автозапуск. `status` показывает оба задания.
- `cremote doctor` — проверки Node, `claude`, хуков (узел и скрипт существуют), сервисов, `GET /api/health` на `127.0.0.1:<port>` и доступа по режиму. Строки `✓`/`✗`, код выхода 1 при ошибках.
- `cremote version` — версия из `package.json`.
- `cremote update` — добавит следующий срез.

`GET /api/health` отвечает без авторизации: `{ ok: true, version }`.

## Сервисы и доступ

- macOS: LaunchAgents `dev.cremote.server` и `dev.cremote.tunnel`. Linux: `systemd --user` юниты `cremote.service` и `cremote-tunnel.service` в `~/.config/systemd/user`. Для работы без входа в систему нужен `loginctl enable-linger $USER`. На других ОС команда `service` сообщает об ошибке. Логи — `~/.cremote/logs`. В сервисах и хуках стоит абсолютный путь к `node`.
- Доступ задаётся в `config.json`: `access: { mode: "ssh"|"tailscale"|"cloudflare"|"none", ssh: { target, remotePort, identityFile? }, cloudflare: { token }, publicUrl? }`. Старое поле `tunnel: "user@host"` читается как `access.ssh` с `remotePort` 3010. Также: `host`, `vapidSubject`, `autoUpdate` (`notify`|`auto`|`off`).
- `ssh`: задание туннеля `ssh -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R 127.0.0.1:<remotePort>:127.0.0.1:<port> [-i файл] user@vps.example.com`, KeepAlive/Restart=always.
- `cloudflare`: `cloudflared tunnel run`, токен передаётся в `TUNNEL_TOKEN`, а не в аргументах. launchd: plist с правами 600. systemd: `EnvironmentFile=~/.cremote/tunnel.env` с правами 600.
- `tailscale`: задания туннеля нет. Мастер предлагает выполнить `tailscale serve --bg http://127.0.0.1:<port>` и берёт адрес из `tailscale status --json`.
- `none`: задания туннеля нет, сервер слушает только `127.0.0.1`.
- Поиск процессов Claude: macOS — `ps -axo pid=,ppid=,lstart=,command=` и `lsof` для cwd. Linux — `ps -eo pid=,ppid=,lstart=,args=` и `readlink /proc/<pid>/cwd` (запасной вариант `lsof`).

## Файлы

Пути и локальные ссылки в сообщениях Claude открываются с телефона через `GET /api/file?path=<путь>&session=<id>` (нужна cookie).

- Разрешённые корни (после `realpath`): cwd сессии, `~/Downloads`, `~/Desktop`, `~/Documents`, `/private/tmp/claude-<uid>`, `/tmp/claude-<uid>`, `~/.cremote/uploads` и `fileRoots` из `config.json`.
- Путь очищается от `file://`, якорей `#L10` и суффикса `:12:3`. `~` раскрывается. Относительный путь считается от cwd сессии, без сессии это 400.
- Симлинки раскрываются, итоговый путь обязан лежать внутри корня. `../` и симлинк наружу дают 403.
- Всегда закрыто: сегменты `.ssh .gnupg .aws .kube .docker .git Keychains .config/gh`, всё под `~/.claude`, имена `.env*`, `.netrc`, `.npmrc`, `.pypirc`, `.claude.json`, `id_rsa*`/`id_ed25519*`/`id_ecdsa*`, расширения `.pem .key .p12 .pfx .keystore`.
- Ошибки: 400 неверный путь, 403 закрыто, 404 нет файла или это папка (листинга нет). Максимум 200 МБ.
- Картинки, pdf, аудио и видео отдаются inline со своим типом, поддерживается `Range`. Текст и код (в том числе html и svg) отдаются как `text/plain; charset=utf-8`. Остальное — `application/octet-stream` с `Content-Disposition: attachment`.
- Заголовки: `X-Content-Type-Options: nosniff`, CSP `default-src 'none'; … sandbox`, `Cache-Control: private, max-age=60`.
- `?meta=1` возвращает JSON `{name,size,kind,mime}`.
- Web: `renderMarkdown(text, {cwd, sessionId})` переписывает локальные ссылки и картинки на `/api/file`, а `code` с путём оборачивает в ссылку. Тап открывает `FileViewer`: картинка, текст (до 1 МБ), для pdf/видео и бинарных файлов — кнопка «Открыть» или «Скачать».

## Интерфейс (mobile-first, PWA)

- **Вход:** поле пароля.
- **Список сессий:** Сессии сгруппированы по проекту и отсортированы по `mtime`. У каждой бейдж статуса, источник и относительное время. Сессии с pending подсвечены. Кнопка «Новая сессия».
- **Сессия:** лента сообщений. Markdown через `marked` + `DOMPurify`, код моноширинным шрифтом. `thinking` и вызовы инструментов свёрнуты в строку-сводку: `Edit path`, `Bash: команда`, `Read path`. Для Edit и Write разворачивается diff. Ошибки результатов подсвечены. Sidechain-сообщения сабагентов свёрнуты в группу. Автопрокрутка вниз, если пользователь внизу. Наверху кнопка «Загрузить ещё».
- **Карточки pending** закреплены над полем ввода:
  - **Разрешение:** имя инструмента, вход (для Bash — команда, для Edit — diff). Кнопки «Разрешить», «Разрешить всегда» (если есть `suggestions`; передаёт их как `updatedPermissions`) и «Отклонить» с необязательным комментарием.
  - **Вопрос:** все вопросы с вариантами, multiSelect и полем «Другое».
- **Поле ввода:** текст, прикрепление картинок (камера или галерея, превью, загрузка через `/api/upload`), «Отправить», «Стоп» во время работы. Пока Claude работает в VS Code, сообщение встаёт в очередь, подсказка: «Claude прочитает после текущего шага». Очередь видна над полем ввода, каждое сообщение можно отменить. Если сессия простаивает, подсказка: «Разбудит Claude во вкладке VS Code». Если вкладка открыта без хуков, поле заблокировано с советом перезагрузить окно VS Code.
- **SDK-сессии:** селектор режима разрешений.
- **Новая сессия:** выбор проекта из `/api/projects` или ввод пути, режим, модель (необязательно), первое сообщение с картинками.
- Уведомления: вибрация и звук при новом pending, пока вкладка открыта. Заголовок вкладки показывает счётчик pending.
- Тема: светлая и тёмная по `prefers-color-scheme`. Учитываются безопасные зоны iOS. `manifest.webmanifest` с иконкой.
- Переподключение WS с backoff, индикатор связи. После переподключения клиент заново подписывается на открытую сессию.
