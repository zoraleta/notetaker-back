# gateway

Единственный публичный воркер: CORS, JWT, проксирование запросов фронта в internal-воркеры через Service Bindings.

## Воркер
`notetaker-api-gateway` — единственный воркер с публичным URL (`workers_dev = true`). Все запросы фронта идут сюда; во внутренние воркеры доходит уже валидированный `userId`.

## Логика работы

**Порядок middleware в `src/index.ts`:**
1. `corsMiddleware` (на `*`) — preflight (OPTIONS) и CORS-заголовки. Origin-whitelist жёсткий, см. ниже.
2. `app.route('/auth', authRoutes)` — анонимные роуты регистрации/логина (без JWT — токен ещё не выдан).
3. `jwtMiddleware` — навешивается на префиксы будущих защищённых групп: `/notes/*`, `/ai/*`, `/projects/*`, `/links/*`, `/settings/*`. На Phase 3 ни одна из групп ещё не имеет роутов — middleware готов к подключению, но не срабатывает.
4. `app.onError` — централизованный обработчик непредвиденных ошибок (см. CLAUDE.md → правило 5). Ожидаемые ошибки приходят как `{ error, code }` от internal-воркеров и проксируются «как есть».
5. `app.notFound` — единый формат `{ error, code: 'NOT_FOUND' }`.

**JWT-middleware (`src/middleware/jwt.middleware.ts`):**
1. Из `Authorization: Bearer <token>` достаётся токен. Нет/неверный формат → `401 UNAUTHORIZED`.
2. `jwt.verify<JwtPayloadShape>(token, JWT_SECRET, { algorithm: 'HS256' })` — проверяет подпись и `exp`. По дефолту возвращает `undefined` вместо throw на невалидном/истёкшем токене.
3. Если `payload.userId` или `payload.email` отсутствуют → `401 UNAUTHORIZED`.
4. Иначе `c.set('user', { id, email })` — Hono Variables.

**Прокси в internal-воркеры (`src/lib/proxy.ts → proxyToService`):**
1. Принимает `target: Fetcher` (Service Binding), исходный `request: Request`, `internalPath` (путь, который слушает internal-воркер) и опциональный `userId`.
2. Переписывает `URL.pathname` на `internalPath` (gateway-роут `/auth/register` → auth-роут `/register`).
3. Если передан `userId` — ставит заголовок `x-user-id`. Если не передан — **затирает** входящий `x-user-id`, чтобы фронт не мог подменить личность в обход JWT.
4. Вызывает `target.fetch(proxiedRequest)` — прямой канал между воркерами, без публичного URL.

**Анонимные роуты (`src/routes/auth.routes.ts`):**
- `POST /auth/register` → proxy → `notetaker-auth` `/register`.
- `POST /auth/login` → proxy → `notetaker-auth` `/login`.

**Защищённые роуты (`src/routes/notes.routes.ts`):**
- `POST /notes`, `GET /notes`, `GET /notes/:id`, `PATCH /notes/:id`, `DELETE /notes/:id` → proxy → `notetaker-notes` (тот же путь). Префикс совпадает, поэтому `proxyToService` вызывается без `internalPath` и URL сохраняется как есть. `x-user-id` берётся из `c.get('user').id` (поставлен JWT-middleware).
- `GET /notes/:id/similar` — особый случай: путь под `/notes/`, но эндпоинт принадлежит AI (F8 «Похожие заметки»). Прокси идёт в `notetaker-ai`, не в `notetaker-notes`. **Регистрация ДО `/:id`** в `Hono` (first-match): без правильного порядка `/:id` поглотит `/:id/similar`.

**AI-роуты (`src/routes/ai.routes.ts`, Phase 5B/5D/5E/5F/5G):**
- `POST /ai/search` *(5B)* — proxy → `notetaker-ai` `/search` (с `internalPath: '/search'`, потому что `/ai/` — gateway-неймспейс, ai-воркер слушает без него).
- `POST /ai/summarize` *(5D)* — proxy → `notetaker-ai` `/summarize`. SSE-стрим (`text/event-stream`); `authenticatedProxy` возвращает `target.fetch(...)` напрямую, поэтому ReadableStream проходит без буферизации.
- `POST /ai/classify` *(5E)* — proxy → `notetaker-ai` `/classify`. Body `{ contentText }`; ответ `{ projectId, score }`.
- `GET /ai/develop-suggestions` *(5F)* — proxy → `notetaker-ai` `/develop-suggestions`. Без тела/query.
- `POST /ai/discuss` *(5G)* — proxy → `notetaker-ai` `/discuss`. SSE-стрим с RAG-контекстом из соседей якорной заметки.
- `POST /ai/pack-into-project` *(5G)* — proxy → `notetaker-ai` `/pack-into-project`. Body `{ dialog }`; JSON-ответ `{ goal, stages, openQuestions }`.

**Settings-роуты (`src/routes/settings.routes.ts`, Phase 5C):**
- `GET /settings`, `PUT /settings/active-model`, `PUT /settings/prompts/:key`, `DELETE /settings/prompts/:key` → proxy → `notetaker-ai` (тот же путь, без `internalPath` — префиксы совпадают). Защищены `jwtMiddleware` через `app.use('/settings/*', jwtMiddleware)`. ai-воркер сам `userId` не использует (настройки глобальные), но JWT всё равно обязателен — это guard «авторизован — может править».

Тело запроса валидируется в целевых internal-воркерах, gateway его не парсит и не дублирует Zod-схемы. Стримы через SVC binding передаются «как есть» — `proxyToService` возвращает `target.fetch(...)` напрямую, без `.json()`/`.text()`, поэтому `text/event-stream` (Phase 5D summarize, 5G discuss) пройдут без буферизации.

## Зависимости
- **Service Binding `AUTH`** (`Fetcher`) → воркер `notetaker-auth`.
- **Service Binding `NOTES`** (`Fetcher`) → воркер `notetaker-notes`.
- **Service Binding `AI`** (`Fetcher`) → воркер `notetaker-ai` (Phase 5B).
- **`env.JWT_SECRET`** → секрет, должен совпадать со значением в `notetaker-auth` (auth подписывает, gateway проверяет). Локально — `api-gateway/.dev.vars`, в проде — `wrangler secret put JWT_SECRET`.
- **Внешние пакеты:** `hono`, `@hono/zod-validator`, `zod`, `@tsndr/cloudflare-worker-jwt`.

`DB`, `env.AI: Ai`, `env.VECTORIZE` — не привязаны и **не должны** быть привязаны к этому воркеру (`AI` здесь — `Fetcher`, Service Binding на ai-воркер, а не Workers AI binding).

В Phase 6–7 сюда добавятся Service Bindings: `PARSER`, `PROJECTS`.

## Routes (публичные)
- `POST /auth/register` — JSON `{ email, password }`. Валидируется и обрабатывается в `notetaker-auth`. Ответ: `201 { token, user: { id, email } }` или `400 { error, code: 'VALIDATION' }`.
- `POST /auth/login` — то же тело. Ответ: `200 { token, user }` или `401 { error, code: 'UNAUTHORIZED' }`.
- `POST/GET/GET/:id/PATCH/:id/DELETE/:id` под `/notes` — F2 CRUD заметок. Защищены JWT-middleware. Контракт описан в `docs/modules/notes.md`.
- `GET /notes/:id/similar` — F8 «Похожие заметки», прокси в `notetaker-ai`. Контракт в `docs/modules/ai.md`.
- `POST /ai/search` — F8 семантический поиск, прокси в `notetaker-ai`. Контракт в `docs/modules/ai.md`.
- `POST /ai/summarize` — F1 SSE-саммари статьи, прокси в `notetaker-ai`. Контракт в `docs/modules/ai.md`.
- `POST /ai/classify` — F3 RAG-классификация, прокси в `notetaker-ai`. Контракт в `docs/modules/ai.md`.
- `GET /ai/develop-suggestions` — F4 кандидаты на «развей тему», прокси в `notetaker-ai`. Контракт в `docs/modules/ai.md`.
- `POST /ai/discuss` — F5 SSE-чат «обсуди идею» с RAG-контекстом, прокси в `notetaker-ai`. Контракт в `docs/modules/ai.md`.
- `POST /ai/pack-into-project` — F5 структурированная упаковка диалога в проект, прокси в `notetaker-ai`. Контракт в `docs/modules/ai.md`.
- `GET /settings`, `PUT /settings/active-model`, `PUT /settings/prompts/:key`, `DELETE /settings/prompts/:key` — F7 AI-настройки, прокси в `notetaker-ai`. Контракт в `docs/modules/ai.md`.

Остальные публичные роуты появятся в Phase 6–7 (`/projects/*`, `/links/*`).

## Internal endpoints / RPC
Не имеет — gateway сам ни с кем не говорит как сервер для других воркеров. Только клиент Service Bindings.

## Services
Сервисов нет: бизнес-логика живёт в internal-воркерах. Gateway содержит только middleware, роуты-прокси и helper `proxyToService`.

## Queries (db/)
Не имеет — gateway не работает с D1. Все запросы к БД идут из internal-воркеров.

## Ограничения

- **Единственный воркер с публичным URL.** Других воркеров с `workers_dev = true` или `[[routes]]` быть не должно (CLAUDE.md → правило 1, антипаттерн «Internal-воркер с публичным `[[routes]]`»).
- **JWT валидируется только здесь** (CLAUDE.md → правило 11). Internal-воркеры доверяют заголовку `x-user-id`.
- **Заголовок `x-user-id` затирается на анонимных роутах** в `proxyToService`. Без этой защиты фронт мог бы подменить пользователя, не имея валидного JWT.
- **CORS — статический whitelist** (`ALLOWED_ORIGINS` в `cors.middleware.ts`). На старте только `http://localhost:5173`; production-домен Pages добавится после Phase 9.
- **Нет Workers AI и Vectorize биндингов.** Все AI-вызовы и vector-операции — через Service Binding на `notetaker-ai` (CLAUDE.md → правила 9–10).
- **Нет D1.** Если когда-нибудь gateway понадобятся свои таблицы (например, для blocklist токенов) — это **отдельное** решение, а не «по дефолту».
- **`wrangler.jsonc` и `Env` синхронны.** При добавлении нового Service Binding обязательно `npx wrangler types` (обновляет `worker-configuration.d.ts`) и обновление `Env` в `src/config/env.ts`.
