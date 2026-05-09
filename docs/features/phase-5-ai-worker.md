# Phase 5 — `ai`-воркер

> Декомпозиция Phase 5 из [`general-docs/tech-plan.md`](../../../general-docs/tech-plan.md). Покрывает фичи F1, F3, F4, F5, F7, F8.

## Цель

Поднять единственный воркер с биндингами Workers AI и Vectorize: `notetaker-ai`. Все AI-вызовы и vector-операции проекта живут только здесь. Подключить к gateway. Подключить хук индексации заметок в `notes`-воркере. На выходе: гибридный конфиг (дефолты в коде + override в D1), векторный слой F8, settings F7, чат-эндпоинты F1/F5, классификация F3, предложения F4.

## Решения, зафиксированные перед стартом

1. **Дробление на 7 под-этапов** (по фичам) — отдельный коммит, отдельный smoke, отдельный вызов агентов на каждом.
2. **`waitUntil` после CRUD заметки живёт в `notes`-воркере** (не в gateway). `notes` получает SVC binding `AI`. Аргументы: gateway остаётся thin proxy (не парсит ответ notes); владение жизненным циклом заметки (включая её индексацию) сосредоточено в notes; CLAUDE.md правило 9 явно разрешает любому воркеру звать `ai` через SVC binding.
3. **Embedding-модель — константа** (`@cf/baai/bge-m3`, 1024 dim). Через UI меняется только chat-модель. Смена embedding = новый Vectorize-индекс + reindex; не делаем в Phase 5.
4. **`isIndexedAt` в `notes`** остаётся `null` на Phase 5. Обновление флага требовало бы обратной петли `ai → notes` через SVC binding `NOTES` в ai (ради отладочной метаданной). YAGNI: реальной потребности (mass-reindex) нет — добавим, когда появится.
5. **Auto-classification (F3)** — синхронный `POST /ai/classify` от фронта (не часть `waitUntil`). Юзеру нужен suggestion в ответе.
6. **userId передаётся ТОЛЬКО заголовком `x-user-id`** во всех вызовах к ai (от gateway, от notes). Body резервируется под доменные данные (`{ noteId, contentText, query, topK, ... }`). Стиль уже зафиксирован в Phase 4 (gateway → notes использует `x-user-id`). В ai-воркере добавляется тот же middleware `requireUserId` (копия из notes — DRY trade-off за CLAUDE.md «общие хелперы копируются»).
7. **Без retry-очереди для фоновой индексации.** `executionCtx.waitUntil(env.AI.fetch(...))` — без retry-обёрток. Если эмбеддинг/upsert упали (Workers AI 429, Vectorize пятисотка) — ошибка идёт только в `wrangler tail`. Mass-reindex как admin-операция = за рамками Phase 5 (CLAUDE.md «Векторный индекс» уже это говорит).

## Этапы

### 5A — Skeleton ai-воркера + D1 + конфиг (~45 мин)

**Цель:** воркер запускается локально (`wrangler dev` на порту 8791), подключён к D1 через биндинг `DB`, к Workers AI через `[ai]`, к Vectorize через `[[vectorize]]`. Есть две таблицы и хелперы чтения настроек. Нет ни одного бизнес-эндпоинта.

**Файлы (новые):**
- `ai/wrangler.jsonc` — `name=notetaker-ai`, `workers_dev: false`, биндинги `DB`/`AI`/`VECTORIZE`, `dev.port=8791`.
- `ai/package.json`, `ai/tsconfig.json`, `ai/.editorconfig`, `ai/.prettierrc`, `ai/.gitignore` (по образцу `notes/`).
- `ai/drizzle.config.ts`.
- `ai/src/index.ts` — Hono app, `app.onError`, `app.notFound` (по образцу `notes/src/index.ts`). Без routes на этом этапе — только healthcheck `GET /` для smoke.
- `ai/src/config/env.ts` — `Env { DB, AI: Ai, VECTORIZE: VectorizeIndex }`, `AppBindings`.
- `ai/src/config/ai-models.ts` — `ALLOWED_MODELS`, `DEFAULT_MODEL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`.
- `ai/src/config/prompts.ts` — `DEFAULT_PROMPTS` (summarize / classify / discuss / pack-into-project), `PromptKey`.
- `ai/src/db/schema.ts` — таблицы `settings(key, value, updatedAt)` и `prompts(key, value, updatedAt)`.
- `ai/src/db/settings.queries.ts` — `getSetting`, `setSetting`.
- `ai/src/db/prompts.queries.ts` — `getPromptOverride`, `setPromptOverride`, `deletePromptOverride`.
- `ai/src/services/settings.service.ts` — `getActiveModel(env)`, `getPrompt(env, key)`. Гибрид: D1 → fallback на `DEFAULT_*`. Невалидная модель в D1 → fallback (whitelist-validated).
- `ai/src/lib/result.ts` — копия из notes/auth (DRY trade-off за CLAUDE.md «Общие Zod-схемы и типы — копируются между воркерами»).
- `ai/src/lib/user-context.ts` — копия `requireUserId` из notes (читает `x-user-id`, кладёт в Variables; пусто → 401).
- `ai/src/lib/http.ts` — `STATUS_BY_CODE`, `validationHook`, `toResponse`. Копия паттерна из [`notes/src/routes/notes.ts:60-118`](../../notes/src/routes/notes.ts#L60-L118), вынесенная в shared lib (в notes они inline; ai-воркер с 5+ роут-файлами оправдывает выделение). Импортируются всеми `ai/src/routes/*.ts`. Без этого хелпера у ai будет несогласованный с notes формат ошибок.
- `ai/drizzle/0001_initial.sql` — миграция (генерится `drizzle-kit generate`).

**D1:** добавляем 2 таблицы. Миграция применяется и локально (`wrangler d1 migrations apply notetaker --local`), и на проде в Phase 9.

**DoD 5A:**
- [ ] `npm run typecheck` чистый.
- [ ] `wrangler dev` (на 8791) поднимает воркер; `GET /` отвечает `200`.
- [ ] Миграция применена в локальной D1 (`select name from sqlite_master where type='table'` → `settings, prompts, notes, users`).
- [ ] **Workers AI binding работает** — добавить временный smoke-эндпоинт (или через `GET /` встроить debug-проверку) `env.AI.run('@cf/baai/bge-m3', { text: ['hello'] })` возвращает массив длиной 1024. Удаляется в 5B при появлении настоящих vector-роутов.
- [ ] `getActiveModel(env)` без записи в `settings` возвращает `DEFAULT_MODEL`; после `setSetting('active_model', '@cf/meta/llama-3.3-70b-instruct-fp8-fast')` возвращает её; после `setSetting('active_model', 'invalid')` возвращает `DEFAULT_MODEL` (валидация по whitelist в самой service).
- [ ] `getPrompt(env, 'summarize')` без override возвращает `DEFAULT_PROMPTS.summarize`; после записи override — возвращает override.
- [ ] Документ `docs/modules/ai.md` создан (skeleton-секция).

### 5B — F8: vector layer + хук индексации в `notes` (~1 ч)

**Цель:** заметки автоматически индексируются в Vectorize при CRUD; Cmd+K и «Похожие» работают через gateway.

**Новые эндпоинты в ai (internal, без публичного route — gateway проксирует):**

Все эндпоинты ниже принимают `x-user-id` через заголовок (см. решение 6). Body — только доменные данные.

- `POST /internal/vectors/upsert` — header `x-user-id`, body `{ noteId, contentText, projectId }`. Эмбеддит `EMBEDDING_MODEL`, делает `VECTORIZE.upsert([{ id: 'note:'+noteId, namespace: userId, values, metadata: { userId, noteId, projectId, type: 'note', updatedAt: Date.now() } }])`. Возвращает `204`.
- `POST /internal/vectors/delete` — header `x-user-id` (для namespace-консистентности), body `{ noteId }`. `VECTORIZE.deleteByIds(['note:'+noteId])`. Возвращает `204`.
- `POST /search` — header `x-user-id`, body `{ query, topK? }`. Эмбеддит query, `VECTORIZE.query(values, { namespace: userId, topK: topK ?? 10, filter: { userId } })`. Возвращает `[{ noteId, score, projectId? }]`.
- `GET /notes/:id/similar` — header `x-user-id`, query `?topK=5`. Делает `VECTORIZE.queryById('note:'+id, { namespace: userId, topK: topK+1, filter: { userId }, returnValues: false })`, выкидывает self из ответа, возвращает топ-N. Если у заметки ещё нет вектора (только что создана, индексация в фоне) — `200 []`.

**Структура слоёв:**
- `ai/src/routes/vectors.routes.ts` (`/internal/vectors/*`) и `ai/src/routes/search.routes.ts` (`/search`, `/notes/:id/similar`).
- `ai/src/services/embedding.service.ts` — `embedText(env, text): Promise<number[]>`.
- `ai/src/services/vectors.service.ts` — `upsertNoteVector`, `deleteNoteVector`.
- `ai/src/services/search.service.ts` — `searchByQuery`, `findSimilarToNote`.
- `ai/src/db/vectors.queries.ts` — обёртки над `env.VECTORIZE.upsert/query/queryById/deleteByIds` (CLAUDE.md правило: «не пишем `BaseVectorRepository`, нативный API короткий, но называем по аналогии с D1-queries»).

**Внутренние эндпоинты валидируются Zod.** `internal` ≠ `untrusted`: gateway/notes могут случайно прислать кривой payload, и зависание/500 без явной ошибки усложнит дебаг. Все `/internal/vectors/*`, `/search`, `/notes/:id/similar` валидируются через `zValidator('json'|'query', schema, validationHook)` (как в notes-воркере).

**Подключение к gateway:**
- `api-gateway/wrangler.jsonc` → добавить SVC binding `AI` → `notetaker-ai`.
- `api-gateway/src/config/env.ts` → `AI: Fetcher`.
- `api-gateway/src/routes/ai.routes.ts` (новый) — публичные `POST /search`, `GET /notes/:id/similar` под JWT-middleware (уже подвешен на `/ai/*` в `index.ts`). Префиксы:
  - Фронт зовёт `POST /ai/search` → gateway проксирует в `ai` на `/search` (через `internalPath`).
  - Фронт зовёт `GET /notes/:id/similar` → gateway проксирует в `ai`. **Нюанс:** `/notes/*` уже подвешен на JWT. `/notes/:id/similar` тоже под JWT, проксируем в AI (не в notes!). Решение: в `api-gateway/src/routes/notes.routes.ts` добавить роут `.get('/:id/similar', proxyToAi)` **до** существующего `.get('/:id', proxyNotes)` — Hono матчит первый подходящий роут (first-match), и без правильного порядка `:id` поглотит `:id/similar`.
- `/internal/vectors/*` — **не** проксируется через gateway (это internal-only, недоступно фронту).

**Хук в `notes`-воркере:**
- `notes/wrangler.jsonc` → SVC binding `AI` → `notetaker-ai`.
- `notes/src/config/env.ts` → `AI: Fetcher`.
- `notes/src/services/notes.service.ts` — расширить return type `createNote/updateNote/deleteNote` на `Result<{ note?: Note; index: IndexAction }>`, где
  ```ts
  type IndexAction =
    | { kind: 'upsert'; userId: string; noteId: string; contentText: string; projectId: string | null }
    | { kind: 'delete'; userId: string; noteId: string }
    | null
  ```
  Сервис остаётся HTTP-agnostic (CLAUDE.md правило 2): не зовёт `env.AI.fetch`, не принимает `ExecutionContext`. Альтернатива (передать `executionCtx` аргументом) нарушает правило 2 — отказываемся.
- `notes/src/routes/notes.ts` — после успеха сервиса роут читает `result.data.index` и делает (если не `null`):
  ```ts
  c.executionCtx.waitUntil(
    c.env.AI.fetch('https://internal/internal/vectors/upsert', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ noteId, contentText, projectId }),
    })
  )
  ```
  **Без `await` на внешнем уровне** — `waitUntil` принимает Promise, не Awaited. Cloudflare runtime удерживает воркер живым до резолва.
- На `PATCH` — слать `upsert` всегда (даже если изменён только `title`/`tags`); micro-оптимизация по diff не стоит сложности.

**DoD 5B:**
- [ ] `POST /notes` через gateway → через 1-2 сек `wrangler vectorize get-by-ids notetaker-vectors --ids note:<id>` показывает запись с правильным `namespace`/`metadata`.
- [ ] `PATCH /notes/:id` (изменить contentText) → `updatedAt` в metadata Vectorize обновился.
- [ ] `DELETE /notes/:id` → `wrangler vectorize get-by-ids` возвращает пусто.
- [ ] `POST /ai/search { query }` возвращает релевантные `noteId` (по семантике, минимум 2 заметки разных тем для проверки).
- [ ] `GET /notes/:id/similar` возвращает топ-N **без self** и **только** из namespace текущего юзера (создаём двух юзеров, проверяем).
- [ ] Cross-user изоляция: `POST /search` от Bob не возвращает Alice'ины заметки даже при идентичном тексте.
- [ ] `notes/wrangler.jsonc` имеет SVC binding `AI`; `notes/src/config/env.ts` обновлён; `routes/notes.ts` стреляет `executionCtx.waitUntil` без `await`.
- [ ] Если ai упал (имитируем — выключаем `notetaker-ai` в dev), CRUD заметки проходит успешно; в `wrangler tail` видна ошибка фоновой задачи.
- [ ] `POST /internal/vectors/upsert` без `x-user-id` → `401 UNAUTHORIZED` (`requireUserId` middleware копируется из notes).
- [ ] `POST /internal/vectors/upsert` с невалидным body (нет `noteId`, или `contentText` не строка) → `400 VALIDATION` (Zod на internal endpoint).
- [ ] `docs/modules/ai.md` дополнен секцией F8.
- [ ] `docs/modules/notes.md` обновлён (добавлен SVC binding `AI`, описан хук).
- [ ] Вызваны 🤖 `api-guardian` + `clean-code-guardian`.

### 5C — F7: settings CRUD (~30 мин)

**Цель:** override промптов и активной модели через UI без редеплоя.

**Эндпоинты в ai:**
- `GET /settings` — `{ activeModel, prompts: { [key]: { default, override?, effective } }, embeddingModel, embeddingDimensions, allowedModels }`.
- `PUT /settings/active-model` — body `{ model }`. Zod-проверка по `ALLOWED_MODELS`. `setSetting('active_model', model)`.
- `PUT /settings/prompts/:key` — body `{ value }`. Zod-проверка `key` по `Object.keys(DEFAULT_PROMPTS)`. `value` — строка длиной ≤ 8000.
- `DELETE /settings/prompts/:key` — `deletePromptOverride(key)` (вернётся дефолт).

**Файлы (новые в этом этапе):**
- `ai/src/routes/settings.routes.ts` — все 4 роута, Zod-схемы, `validationHook`/`toResponse`.
- Расширение `ai/src/services/settings.service.ts` (создан в 5A) — добавляются `listSettings`, `setActiveModel`, `setPromptOverride`, `deletePromptOverride` (DB-функции уже есть из 5A).

**Подключение к gateway:**
- `api-gateway/src/routes/settings.routes.ts` (новый) — все 4 роута под JWT-middleware (уже на `/settings/*`).
- Префикс gateway = префикс ai (`/settings`). `internalPath` не нужен.

**DoD 5C:**
- [ ] `GET /settings` без записей — все `effective = default`, `override = undefined`.
- [ ] `PUT /settings/active-model { model: 'invalid' }` → `400 VALIDATION`.
- [ ] `PUT /settings/active-model { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }` → `200`; `GET /settings` показывает её как activeModel.
- [ ] `PUT /settings/prompts/summarize { value: 'тест' }` → `200`; `GET /settings` показывает override.
- [ ] `DELETE /settings/prompts/summarize` → `204`; `GET /settings` снова показывает default.
- [ ] `PUT /settings/prompts/unknown-key` → `400 VALIDATION`.
- [ ] `GET /settings` без JWT → `401` (на gateway-уровне).
- [ ] `docs/modules/ai.md` дополнен секцией F7.
- [ ] Вызваны 🤖 `api-guardian` + `clean-code-guardian`.

### 5D — F1: `/summarize` со стримом (~30 мин)

**Цель:** саммари статьи стримится посимвольно.

**Эндпоинт в ai:**
- `POST /summarize` — body `{ text }`. Zod: `text` — строка `100..200000` симв. Достаёт активную модель и `summarize`-промпт. `env.AI.run(model, { messages: [{ role: 'system', content: prompt }, { role: 'user', content: text }], stream: true })`. Возвращает `Response` со стримом `text/event-stream`.

**Подключение к gateway:**
- `POST /ai/summarize` под JWT-middleware. Прокси в ai на `/summarize`. **Стримы в Service Bindings работают** — Hono не буферизует Response, gateway возвращает body как есть.

**DoD 5D:**
- [ ] `curl --no-buffer -X POST http://localhost:8787/ai/summarize -d '{"text":"<длинная статья>"}'` стримит токены посимвольно.
- [ ] Модель меняется через `PUT /settings/active-model`, следующий `/summarize` использует новую.
- [ ] Промпт меняется через `PUT /settings/prompts/summarize`, следующий `/summarize` его использует.
- [ ] `text < 100` или `text > 200000` → `400 VALIDATION`.
- [ ] Без JWT → `401`.
- [ ] `docs/modules/ai.md` дополнен секцией F1.
- [ ] Вызваны 🤖 `api-guardian` + `clean-code-guardian`.

### 5E — F3: `/classify` (~30 мин)

**Цель:** при создании заметки фронт получает suggestion `projectId | null` через RAG-классификацию (top-K соседей → большинство).

**Эндпоинт в ai:**
- `POST /classify` — header `x-user-id`, body `{ contentText }`. Эмбеддит `contentText`. `VECTORIZE.query(values, { namespace: userId, topK: 20, filter: { userId } })`. Считает: для каждого `projectId` соседей — сумма score. Возвращает `{ projectId, score }` если max-score > 0.75 и `projectId !== null`; иначе `{ projectId: null }`.

> **Решение по центроидам.** Tech-plan 5.5 предлагает «лениво через top-K соседей» вместо хранения центроидов отдельно. Принимаем как есть — это явно проще (нет новой таблицы), достаточно для теста.

**Подключение к gateway:**
- `POST /ai/classify` под JWT-middleware. Gateway проксирует в ai с заголовком `x-user-id` (`proxyToService` уже это делает, см. `api-gateway/src/lib/proxy.ts`).

**DoD 5E:**
- [ ] Создаём 5 заметок с привязкой к проекту `proj-A` (тема Х) + 5 заметок без проекта (тема Y).
- [ ] `POST /ai/classify { contentText: '<новый текст темы Х>' }` → `{ projectId: 'proj-A', score: > 0.75 }`.
- [ ] `POST /ai/classify { contentText: '<новый текст темы Y>' }` → `{ projectId: null }`.
- [ ] Cross-user изоляция: Bob с темой Х → `{ projectId: null }` (не подсасывает Alice'ин proj-A).
- [ ] Без JWT → `401` (gateway-уровень).
- [ ] `docs/modules/ai.md` дополнен секцией F3.
- [ ] Вызваны 🤖 `api-guardian` + `clean-code-guardian`.

### 5F — F4: `/develop-suggestions` (~30 мин)

**Цель:** dashboard показывает 2-3 короткие заметки, у которых есть «соседи» — кандидаты на развитие.

**Эндпоинт в ai:**
- `GET /develop-suggestions` — header `x-user-id`. Через SVC binding к `notes` достаёт `GET /notes` (тот же эндпоинт, что у фронта; notes требует `x-user-id` — пробрасываем). Фильтрует на стороне ai: `length(contentText) < 600`, **берёт первые 20** (после сортировки `updatedAt DESC` от notes). Для каждой делает `queryById('note:'+id, { topK: 5, filter: { userId } })`, считает соседей со score > 0.65. Возвращает 2-3 кандидата (top по числу соседей), формат `[{ noteId, neighbors: [{ noteId, score }] }]`.

> **Лимит 20 на первичную выборку — анти-DoS.** Если у юзера 1000 коротких заметок, без лимита получим 1000 SVC-вызовов + 1000 `queryById`. Топ-20 по `updatedAt` (свежие) достаточно для F4 — это не тотальный аудит базы, это «что недавно недописал». Лимит — константа в коде ai (не настройка).

**Решение: ai зовёт notes через SVC binding.** Это означает, что `ai/wrangler.jsonc` получает SVC binding `NOTES` → `notetaker-notes`. Это второй случай межворкерного вызова через SVC binding (после notes → ai). Архитектурно симметрично; CLAUDE.md правило 8 позволяет.

> Альтернатива — gateway сам зовёт notes и передаёт список в ai. Менее чисто (gateway снова знает форму payload), отказываемся.

**Файлы (новые в этом этапе):**
- `ai/src/routes/develop.routes.ts` — `GET /develop-suggestions`. Zod на query (если будут параметры) и заголовок (требует `x-user-id`).
- `ai/src/services/develop.service.ts` — `findDevelopCandidates(env, userId): Promise<DevelopCandidate[]>` (зовёт notes через `env.NOTES.fetch`, фильтрует по длине, для top-20 запрашивает Vectorize).
- Расширение `ai/wrangler.jsonc` — добавить SVC binding `NOTES` → `notetaker-notes`.

**Подключение к gateway:**
- `GET /ai/develop-suggestions` под JWT-middleware. Прокси в ai. Gateway добавляет `x-user-id`.

**DoD 5F:**
- [ ] Создаём пользователю 5 коротких заметок (≤ 600 симв) на 2 разные темы (по 2-3 заметки темы каждая) и 5 длинных заметок.
- [ ] `GET /ai/develop-suggestions` возвращает 2 кандидата (по одной короткой каждой темы); длинные не попадают.
- [ ] Если нет ни одной короткой — `[]`.
- [ ] Cross-user изоляция: Bob не получает Alice'ины кандидаты.
- [ ] Без JWT → `401` (gateway-уровень).
- [ ] `docs/modules/ai.md` дополнен секцией F4.
- [ ] `ai/wrangler.jsonc` добавлен SVC binding `NOTES`.
- [ ] Вызваны 🤖 `api-guardian` + `clean-code-guardian`.

### 5G — F5: `/discuss` + `/pack-into-project` (~45 мин)

**Цель:** AI-чат об идее с RAG-контекстом из других заметок юзера; «упаковка» диалога в структурированный JSON для будущего проекта.

**Эндпоинты в ai:**
- `POST /discuss` — header `x-user-id`, body `{ noteId, messages: [{ role, content }] }`. `VECTORIZE.queryById('note:'+noteId, { namespace: userId, topK: 5, filter: { userId } })` (без `returnValues`). По noteIds соседей через SVC binding `NOTES` тянет `contentText` каждой заметки **N×`GET /notes/:id`** (N≤5; SVC binding — это прямой вызов JS-функции в том же runtime, миллисекунды на запрос). Кладёт тексты как RAG отдельным `messages`-блоком (НЕ конкатенацией с `system`-промптом, см. антипаттерны). `env.AI.run(model, { messages: [systemPrompt, ...ragMessages, ...messages], stream: true })`. Стримит как `text/event-stream`.
  - Если профайлинг покажет, что N×`GET` тормозит при росте `topK` — добавим batch endpoint `/notes/by-ids` в notes. Сейчас YAGNI.
  - **Graceful degrade:** если `env.NOTES.fetch` падает или возвращает `404`/`403` для k из N соседей — `/discuss` отвечает с RAG-подмножеством из (N-k) удачных. Если все N упали — стримит без RAG. Не возвращаем 502 для всего `/discuss`.
- `POST /pack-into-project` — header `x-user-id`, body `{ dialog, sourceNoteId? }`. Системный промпт `pack-into-project`. Без стрима, ждёт полный ответ. Парсит JSON через `JSON.parse` → **валидирует через Zod-схему** `z.object({ goal: z.string(), stages: z.array(z.object({ title: z.string(), done: z.boolean() })), openQuestions: z.array(z.string()) })`. Если парсинг или Zod-валидация упали — `Result.err('Не удалось распарсить ответ модели', 'EXTERNAL')` → `502`. Возвращает `200 { goal, stages, openQuestions }`.

**Файлы (новые в этом этапе):**
- `ai/src/routes/discuss.routes.ts` — `POST /discuss`, `POST /pack-into-project`. Zod-схемы тел запроса. `validationHook`/`STATUS_BY_CODE`/`toResponse` (общие хелперы из 5A).
- `ai/src/services/discuss.service.ts` — `gatherRagContext(env, userId, noteId): Promise<string[]>` (queryById + N×GET notes, graceful degrade); `streamDiscuss(env, userId, noteId, messages): Promise<Response>`.
- `ai/src/services/pack.service.ts` — `packDialogIntoProject(env, userId, dialog, sourceNoteId?): Promise<Result<ProjectPack>>` (env.AI.run без стрима + Zod-валидация ответа).

**Подключение к gateway:**
- `POST /ai/discuss` (стрим) и `POST /ai/pack-into-project` (JSON) под JWT-middleware. Gateway проксирует через `proxyToService` — `x-user-id` ставится автоматически из JWT (как и везде в Phase 5; userId в body не передаём).

**DoD 5G:**
- [ ] `POST /ai/discuss { noteId, messages: [{role:'user',content:'разверни тему'}] }` стримит ответ; в логах ai-воркера виден `topK=5` запрос к Vectorize.
- [ ] Если у заметки нет вектора (только что создана, indexing в фоне) → ai отвечает без RAG (без падения).
- [ ] **Graceful degrade RAG**: имитируем падение notes-воркера для одного из соседних `noteId` (например, soft-delete заметки между `queryById` и `GET /notes/:id`) → `/discuss` всё равно стримит, RAG из (N-1) текстов.
- [ ] `POST /ai/pack-into-project { dialog: '...' }` → JSON `{ goal, stages, openQuestions }`. Невалидный JSON ответ модели → `502 EXTERNAL` с осмысленным сообщением.
- [ ] Валидный JSON, но неправильной формы (`{ foo: 'bar' }`) → `502 EXTERNAL` (Zod ловит).
- [ ] Промпты `discuss` и `pack-into-project` меняются через `/settings/prompts/...` без редеплоя.
- [ ] Cross-user: Bob с Alice'ин noteId → `403`/`404` (через SVC binding к notes — уже есть проверка userId в notes-воркере).
- [ ] `docs/modules/ai.md` дополнен секцией F5.
- [ ] Вызваны 🤖 `api-guardian` + `clean-code-guardian`.

## Зависимости между этапами

```
5A (skeleton) ──┬─→ 5B (vectors) ──→ 5E (classify) ──┐
                │                                     │
                ├─→ 5C (settings) ──→ 5D (summarize) ─┤
                │                                     │
                └─→ ─────────────────────────────────►│
                              5B + notes ────→ 5F (develop)
                              5B + 5C + notes ────→ 5G (discuss/pack)
```

5B блокирует 5E, 5F, 5G (нужен embedding + Vectorize). 5C блокирует 5D (нужен `getActiveModel/getPrompt`). 5F и 5G требуют SVC binding `NOTES` в ai — добавляем в 5F.

## Definition of Done всей фазы

Tech-plan §«✅ DoD Phase 5»:

- [ ] `wrangler dev` поднимает воркер. `env.AI.run('@cf/baai/bge-m3', { text: ['hello'] })` возвращает 1024-мерный массив. *(5A)*
- [ ] Создание заметки → через 2-3 сек `wrangler vectorize get-by-ids notetaker-vectors --ids note:<id>` показывает запись. *(5B)*
- [ ] Удаление заметки → запись пропадает. *(5B)*
- [ ] `POST /search` через gateway возвращает релевантные результаты. *(5B)*
- [ ] `GET /notes/:id/similar` возвращает топ-5 без self. *(5B)*
- [ ] `PUT /settings/active-model` с моделью НЕ из whitelist → `400`. *(5C)*
- [ ] `GET /settings` показывает дефолты, потом override после `PUT /settings/prompts/summarize`. *(5C)*
- [ ] `POST /summarize` стримит токены. *(5D)*
- [ ] `notetaker-back/docs/modules/ai.md` создан и заполнен по всем секциям. *(5A → 5G)*

## Антипаттерны, которых избегаем

- **Workers AI binding в gateway/notes** — никогда. Только в ai.
- **Vectorize binding в gateway/notes** — никогда. Только в ai.
- **Прямой `c.env.VECTORIZE.upsert(...)` в роуте** — через `db/vectors.queries.ts`.
- **Cross-user query без `namespace=userId` ИЛИ `filter={userId}`** — оба флага обязательны (двойной guard).
- **Хардкод системных промптов в коде сервиса** — только через `getPrompt(env, key)`.
- **Хранение векторов в D1 параллельно Vectorize** — `notes.is_indexed_at` остаётся флагом, не дублируем данные.
- **Generic `BaseVectorRepository`** — нативный API VECTORIZE из 4 методов, не плодим обёртки.
- **HTTP-вызов между воркерами** — только SVC bindings.
- **JWT-валидация в ai/notes** — никогда. Только gateway.
- **Передача `Context`/`ExecutionContext` в сервис** — сервис HTTP-agnostic. Возвращает `IndexAction`, роут стреляет `waitUntil`.
- **Шаблонные строки промптов с `${variables}` снаружи `getPrompt`** — RAG-контекст добавляется отдельным `messages`-блоком, не конкатенацией с системным промптом.
- **Retry-обёртка над `executionCtx.waitUntil(env.AI.fetch(...))`** — без неё. Ошибки фоновой индексации идут в `wrangler tail`, mass-reindex как admin-операция отложен (CLAUDE.md «Векторный индекс»).
- **Body-параметр `userId`** — не используется. Везде `x-user-id` через заголовок (решение 6). Body — только domain data.
- **Cross-worker batch-эндпоинты «на будущее»** (`/notes/by-ids`) — не создаём, пока N×`GET /notes/:id` не покажет реальный bottleneck.
