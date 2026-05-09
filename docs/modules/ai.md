# ai

AI-функциональность проекта (Phase 5: F1, F3, F4, F5, F7, F8). Эмбеддинги, векторный поиск, чат-эндпоинты, гибридная конфигурация моделей и промптов.

## Воркер
`notetaker-ai` — internal-воркер без публичного `routes`. **Единственный** в системе с биндингами `[ai]` (Workers AI) и `[[vectorize]]` (Vectorize-индекс `notetaker-vectors`). Остальные воркеры зовут его через Service Binding `AI` (CLAUDE.md → правила 4, 5, 9, 10).

## Логика работы

### Гибрид настроек (config + D1) — Phase 5A
Дефолтные значения активной chat-модели и системных промптов лежат в коде (`src/config/ai-models.ts`, `src/config/prompts.ts`) — типизированный whitelist. Override'ы хранятся в D1 (`settings.active_model`, `prompts.<key>`). При чтении `getActiveModel(env)` / `getPrompt(env, key)`:

1. Запрос override из соответствующей таблицы.
2. Для модели — дополнительная проверка по whitelist `ALLOWED_MODELS`: если в БД лежит значение, которого больше нет в whitelist (после редеплоя), возвращаем `DEFAULT_MODEL`.
3. Для промпта — `trim()`; если результат пуст (нет записи или пустая строка), возвращаем `DEFAULT_PROMPTS[key]`.

Embedding-модель — отдельная константа (`EMBEDDING_MODEL = '@cf/baai/bge-m3'`, 1024 dim), через UI **не меняется**: смена модели = смена dimensions = новый Vectorize-индекс (CLAUDE.md → «Векторный индекс»).

### Векторный pipeline F8 — Phase 5B
Семантический поиск и «похожие заметки» поверх Cloudflare Vectorize.

**Lifecycle вектора заметки:**
1. `notes`-воркер после успешного `POST/PATCH/DELETE /notes` возвращает `IndexAction` (discriminated union); роут стреляет `c.executionCtx.waitUntil(env.AI.fetch(...))` в `/internal/vectors/upsert` или `/internal/vectors/delete`. Без `await` — фон ничего не блокирует.
2. `vectors.service` эмбеддит `contentText` через `embedText(env, text)` (Workers AI `@cf/baai/bge-m3` → 1024-мерный вектор) и зовёт `db/vectors.queries` для записи в Vectorize.
3. id вектора детерминированный: `note:<uuid>`. Idempotent upsert: повторный вызов обновит вектор, не создаст дубль.

**Изоляция пользователей: двойной guard.**
- `namespace = userId` — индексная структура Vectorize, разные пользователи в физически разных подмножествах.
- `filter: { userId }` — дополнительная страховка в `query`/`queryById`. Требует metadata-index на поле `userId` (создаётся одноразово через `wrangler vectorize create-metadata-index`).

**Поиск:**
- `POST /search`: эмбеддит `query`, `VECTORIZE.query(values, { namespace, topK, filter, returnMetadata: 'all' })`. Возвращает `[{ noteId, score, projectId }]` отсортированно по убыванию score.
- `GET /notes/:id/similar`: `VECTORIZE.queryById('note:'+id, { topK: topK+1, ... })`, отбрасывает self (тот же id), возвращает топ-N. Если у заметки ещё нет вектора (только что создана, индексация в фоне) — `200 []` без ошибки.

**Latency:** Workers AI embedding ~300-800ms; Vectorize upsert/query ~100-300ms; полное распространение upsert по индексу — несколько секунд (eventual consistency). Свежесозданная заметка появляется в `/search` через 5-15 сек.

**Edge cases (graceful):**
- `projectId === null` хранится в metadata как пустая строка (`NO_PROJECT = ''`) — Vectorize не разрешает `null` в `VectorizeVectorMetadataValue`. На чтении `''` маппится обратно в `null` для фронта.
- Если ai-воркер упал — CRUD заметки уже успешен, юзер ничего не теряет; ошибка фоновой задачи уйдёт в `wrangler tail`. Mass-reindex как admin-операция = за рамками Phase 5.

### Settings F7 — Phase 5C (TBD)
*Ещё не реализовано.* CRUD `/settings/*` для управления `active_model` и `prompts.<key>` через UI.

### Summarize / Classify / Develop / Discuss / Pack — Phase 5D-5G (TBD)
*Ещё не реализовано.*

## Зависимости

- **D1** (`env.DB`, общая база `notetaker`) → таблицы `settings`, `prompts`.
- **Workers AI** (`env.AI: Ai`) — embedding (`@cf/baai/bge-m3`) и chat (`ALLOWED_MODELS`).
- **Vectorize** (`env.VECTORIZE: Vectorize`, индекс `notetaker-vectors`).
- **Внешние пакеты:** `hono`, `@hono/zod-validator`, `zod`, `drizzle-orm`.
- В Phase 5F добавится Service Binding `NOTES` → `notetaker-notes` (для F4 develop-suggestions и F5 discuss RAG).

## Routes (через gateway, под JWT-middleware)

**Реализовано (Phase 5B):**
- `POST /ai/search` — body `{ query: string(1..2000), topK?: number(1..50, default 10) }` → `200 [{ noteId, score, projectId: string|null }]`. Семантический поиск по эмбеддингу запроса в namespace юзера.
- `GET /notes/:id/similar` — query `?topK=N(default 5)` → `200 [{ noteId, score, projectId }]`. Похожие заметки по эмбеддингу указанной заметки (self исключён). `200 []`, если у заметки ещё нет вектора. **gateway регистрирует этот роут ДО `/notes/:id`** (Hono first-match), чтобы `/:id` не поглотил `/:id/similar`.

**Откладывается на следующие этапы:**
- 5C: `GET /settings`, `PUT /settings/active-model`, `PUT /settings/prompts/:key`, `DELETE /settings/prompts/:key`
- 5D: `POST /ai/summarize`
- 5E: `POST /ai/classify`
- 5F: `GET /ai/develop-suggestions`
- 5G: `POST /ai/discuss`, `POST /ai/pack-into-project`

## Internal endpoints / RPC

**Реализовано (Phase 5B):**
- `POST /internal/vectors/upsert` — header `x-user-id`, body `{ noteId: uuid, contentText: string(1..1MB), projectId: string|null }` → `204`. Вызывается из `notes`-воркера через SVC binding `AI` после успешного `POST /notes` или `PATCH /notes/:id`.
- `POST /internal/vectors/delete` — header `x-user-id`, body `{ noteId: uuid }` → `204`. Вызывается из `notes`-воркера после успешного `DELETE /notes/:id` (soft-delete в D1). Идемпотентно — удаление несуществующего вектора не падает.

Internal-эндпоинты **не проксируются через gateway** (фронту недоступны). Валидируются Zod (internal ≠ untrusted). `requireUserId` middleware применяется ко всем `/internal/vectors/*`.

**Smoke (`/__smoke/settings`):** временный, для проверки гибрида settings из 5A. Удаляется в 5C.

## Services

- `getActiveModel(env) → AllowedModel` *(5A)* — гибрид: D1 → whitelist-проверка → fallback на `DEFAULT_MODEL`.
- `getPrompt(env, key: PromptKey) → string` *(5A)* — гибрид: D1 override → trim → fallback на `DEFAULT_PROMPTS[key]`.
- `embedText(env, text) → number[]` *(5B)* — единственное место, которое зовёт `env.AI.run(EMBEDDING_MODEL)`. Defensive-проверка `length === EMBEDDING_DIMENSIONS`, иначе throw → 500.
- `upsertNote(env, { noteId, userId, contentText, projectId }) → void` *(5B)* — `embedText` → `db/upsertNoteVector`.
- `deleteNote(env, noteId) → void` *(5B)* — `db/deleteNoteVectorById`.
- `searchByQuery(env, userId, query, topK) → SearchHit[]` *(5B)* — `embedText` → `queryNoteVectors` → маппинг через `toSearchHit` (NO_PROJECT → null).
- `findSimilarToNote(env, userId, noteId, topK) → SearchHit[]` *(5B)* — `queryNoteVectorsById` с `topK+1`, выкидывает self, мапит. `[]`, если вектора нет.

## Queries (db/)

- `getSetting(db, key) → Setting | null` *(5A)* — select по PK.
- `setSetting(db, key, value) → void` *(5A)* — upsert через `onConflictDoUpdate` (защита от гонки).
- `getPromptOverride(db, key) → PromptOverride | null` *(5A)* — select по PK.
- `setPromptOverride(db, key, value) → void` *(5A)* — upsert.
- `deletePromptOverride(db, key) → void` *(5A)* — DELETE без RETURNING (идемпотентно).
- `vectorIdForNote(noteId) → string` *(5B)* — детерминированный id `note:<uuid>`.
- `upsertNoteVector(index, args) → void` *(5B)* — `Vectorize.upsert` с metadata `{userId, noteId, projectId, type, updatedAt}`. namespace = userId.
- `deleteNoteVectorById(index, noteId) → void` *(5B)* — `Vectorize.deleteByIds`.
- `queryNoteVectors(index, values, options) → VectorizeMatches` *(5B)* — `Vectorize.query` с двойным guard `namespace + filter:{userId}`.
- `queryNoteVectorsById(index, noteId, options) → VectorizeMatches` *(5B)* — `Vectorize.queryById` с тем же двойным guard.

## Ограничения

- **Только в этом воркере существуют биндинги `env.AI: Ai` и `env.VECTORIZE: Vectorize`** (CLAUDE.md → правила 4, 5). Любой другой воркер, которому нужна AI или Vectorize, зовёт ai через Service Binding.
- **Embedding-модель — константа.** Не меняется через UI (CLAUDE.md → «Векторный индекс»: смена = новый индекс + reindex).
- **Whitelist моделей валидируется дважды:** в Zod на роуте `PUT /settings/active-model` (Phase 5C) и в `getActiveModel` (Phase 5A). Защита от устаревшей записи в D1 после редеплоя whitelist'а.
- **Гибрид настроек глобальный, не на пользователя.** `settings.active_model` и `prompts.<key>` влияют на всех. Per-user конфиг — over-engineering для теста.
- **Vectorize в local dev требует `remote: true`** в `wrangler.jsonc` (см. `ai/wrangler.jsonc`); Workers AI тоже работает только remote (CLAUDE.md → «Команды»). Нужен `wrangler login`.
- **Vectorize требует metadata-index на полях, по которым идёт `filter`.** Без `wrangler vectorize create-metadata-index notetaker-vectors --property-name=userId --type=string` запрос с `filter: { userId }` возвращает пустой результат — даже если namespace совпадает и вектор существует. Это **обязательный setup-шаг** для прода (одноразово), и для уже записанных векторов индекс пополняется только при следующем upsert (Cloudflare-конвенция). Список текущих индексов: `wrangler vectorize list-metadata-index notetaker-vectors`.
- **JWT не валидируется здесь.** userId приходит заголовком `x-user-id` от gateway (или от notes для internal-эндпоинтов в 5B). CLAUDE.md → правило 11.
- **Smoke-эндпоинты `/__smoke/*`** существуют только в Phase 5A для DoD-проверок; **удаляются** в 5B/5C при появлении настоящих vector- и settings-роутов. Не подключаются к gateway.
