# ai

AI-функциональность проекта. Эмбеддинги, векторный поиск, чат-эндпоинты, гибридная конфигурация моделей и промптов, работа с групповыми векторами.

## Воркер
`notetaker-ai` — internal-воркер без публичного `routes`. **Единственный** в системе с биндингами `[ai]` (Workers AI) и `[[vectorize]]` (Vectorize-индекс `notetaker-vectors`). Остальные воркеры зовут его через Service Binding `AI` (CLAUDE.md → правила 4, 5, 9, 10).

## Логика работы

### Гибрид настроек (config + D1) — Phase 5A
Дефолтные значения активной chat-модели и системных промптов лежат в коде (`src/config/ai-models.ts`, `src/config/prompts.ts`) — типизированный whitelist. Override'ы хранятся в D1 (`settings.active_model`, `prompts.<key>`). При чтении `getActiveModel(env)` / `getPrompt(env, key)`:

1. Запрос override из соответствующей таблицы.
2. Для модели — дополнительная проверка по whitelist `ALLOWED_MODELS`: если в БД лежит значение, которого больше нет в whitelist (после редеплоя), возвращаем `DEFAULT_MODEL`.
3. Для промпта — `trim()`; если результат пуст (нет записи или пустая строка), возвращаем `DEFAULT_PROMPTS[key]`.

Embedding-модель — отдельная константа (`EMBEDDING_MODEL = '@cf/baai/bge-m3'`, 1024 dim), через UI **не меняется**: смена модели = смена dimensions = новый Vectorize-индекс (CLAUDE.md → «Векторный индекс»).

### Векторный pipeline — Phase 5B / Phase 8
Семантический поиск и «похожие заметки» поверх Cloudflare Vectorize. В Phase 8 добавлена векторизация групп.

**Lifecycle вектора заметки:**
1. `notes`-воркер после успешного `POST/PATCH/DELETE /notes` стреляет `c.executionCtx.waitUntil(env.AI.fetch(...))` в `/internal/vectors/upsert` или `/internal/vectors/delete`. Без `await`.
2. `vectors.service` эмбеддит `contentText` через `embedText(env, text)` (Workers AI `@cf/baai/bge-m3` → 1024-мерный вектор) и зовёт `db/vectors.queries` для записи в Vectorize.
3. id вектора детерминированный: `note:<uuid>`. Idempotent upsert: повторный вызов обновит вектор, не создаст дубль.

**Lifecycle вектора группы (Phase 8):**
1. `notes`-воркер после успешного CRUD группы стреляет `c.executionCtx.waitUntil(env.AI.fetch(...))` в `/internal/vectors/group-upsert` или `/internal/vectors/group-delete`.
2. `vectors.service` эмбеддит `name + description` группы и пишет в Vectorize с id `group:<uuid>`.
3. Используется в `suggestGroups` для семантического подбора группы по тексту заметки.

**Изоляция пользователей: двойной guard.**
- `namespace = userId` — индексная структура Vectorize.
- `filter: { userId }` — дополнительная страховка в `query`/`queryById`. Требует metadata-index на поле `userId` (`wrangler vectorize create-metadata-index`).

**Поиск:**
- `POST /search`: эмбеддит `query`, `VECTORIZE.query(values, { namespace, topK, filter, returnMetadata: 'all' })`. Результаты обогащаются title через SVC binding `NOTES` (`fetchNoteSummary`). Возвращает `[{ noteId, title, score }]` с порогом `MIN_SEARCH_SCORE = 0.4`.
- `GET /notes/:id/similar`: cross-user guard через `fetchNoteContentText` (notes → 404/403 → наружу `NOT_FOUND`). Затем `VECTORIZE.queryById('note:'+id, { topK: topK+1, ... })`, self исключается, порог `MIN_SIMILAR_SCORE = 0.5`. Результаты обогащаются title. Если у заметки нет вектора — `200 []`.

**Latency:** Workers AI embedding ~300-800ms; Vectorize upsert/query ~100-300ms; полное распространение upsert — несколько секунд (eventual consistency). Свежесозданная заметка появляется в `/search` через 5-15 сек.

**Edge cases (graceful):**
- Если ai-воркер упал — CRUD заметки/группы уже успешен; ошибка фоновой задачи уйдёт в `wrangler tail`.

### Settings — Phase 5C
CRUD AI-настроек. Override активной chat-модели и системных промптов через UI без редеплоя.

**Контракт `GET /settings`:**
```
{
  activeModel: AllowedModel,
  allowedModels: AllowedModel[],
  embeddingModel: '@cf/baai/bge-m3',
  embeddingDimensions: 1024,
  prompts: {
    [key in PromptKey]: { default: string, override: string | null, effective: string }
  }
}
```

**Запись:**
- `PUT /settings/active-model { model }` — Zod-проверка по `z.enum(ALLOWED_MODELS)`.
- `PUT /settings/prompts/:key { value }` — `key` по whitelist; `value` — `string ≤ 8000` симв., непустой после trim.
- `DELETE /settings/prompts/:key` — идемпотентно.

**Возврат:** `PUT` отвечает свежим `SettingsView`. `DELETE` отвечает `204`.

**Глобальность.** Настройки на инстанс, не на пользователя. На роутах `/settings/*` нет `requireUserId` — JWT в gateway остаётся guard'ом «авторизован ли вообще».

### Summarize — Phase 5D
Стриминг саммари статьи через Workers AI с `stream: true`. Активная модель и промпт `summarize` читаются из гибрида config+D1.

**Поток:**
1. Zod-валидация `text: 100..200000` симв.
2. `streamSummarize(env, text)`: параллельно тянет модель и промпт.
3. `env.AI.run(model, { messages: [system, user], stream: true })` → `ReadableStream<Uint8Array>` в формате SSE. Поток отдаётся «как есть» через gateway без буферизации.

### Develop — Phase 5F
Дашборд показывает 2-3 коротких заметки с похожими соседями — кандидаты «дописать/развить тему».

**Алгоритм** (`develop.service.ts`):
1. Через SVC binding `NOTES` зовёт `GET /notes`. Заголовок `x-user-id` пробрасывается.
2. Фильтр по длине: `contentText < SHORT_NOTE_MAX = 600`.
3. Берём первые `CANDIDATE_LIMIT = 20` (свежие сверху).
4. Для каждого кандидата `VECTORIZE.queryById(topK = NEIGHBORS_TOPK + 1)` с двойным guard. Соседи со `score < 0.65` отбрасываются.
5. **Theme-deduplication**: группируем кандидатов по `groupId` (без группы — bucket `__none__`), top-1 в каждой группе по числу соседей.
6. Сортируем по числу соседей desc, берём top `SUGGESTIONS_LIMIT = 3`.

**Soft-fail.** Если notes-воркер упал — `fetchUserNotes` возвращает `[]` → ai отдаёт `[]`.

### Discuss — Phase 5G
Стриминг чата с RAG-контекстом из соседних заметок юзера.

**Алгоритм** (`discuss.service.ts`):
1. Параллельно (`Promise.all`) тянем модель, промпт `discuss` и RAG-контекст.
2. RAG (`gatherRagContext`): `VECTORIZE.queryById('note:'+noteId, { topK: RAG_TOPK + 1 })` → self-skip → первые 5 соседних `noteId` → `Promise.all` по `fetchNoteContentText` через SVC binding `NOTES`.
3. Сборка `messages`: `[systemPrompt, ragBlock?, ...userMessages]`. RAG — отдельным `system`-блоком.
4. `env.AI.run(model, { messages, stream: true })` → SSE-поток.

**Cross-user guard:** до стрима `streamDiscuss` проверяет `noteId` через `fetchNoteContentText` (null → `NOT_FOUND`).

**Graceful degrade RAG.** Три уровня поломки, ни один не возвращает 502:
- Нет вектора у якорной заметки → RAG = `[]` → ответ без контекста.
- k из N соседей недоступны → RAG из (N-k) удачных.
- Все N упали → RAG = `[]` → ответ без контекста.

### Merge — Phase 8
Объединение нескольких заметок в одну через LLM.

**Алгоритм** (`merge.service.ts`):
1. Параллельно (`Promise.all`) тянет тексты `activeNote` и выбранных заметок через `fetchNoteContentText` (SVC binding `NOTES`). `activeText === null` → `NOT_FOUND`. Если ни одна из выбранных не вернула текст → `NOT_FOUND`.
2. Тексты оборачиваются в блоки `===Заметка N===`, каждый обрезается до 50 000 симв.
3. `getActiveModel` + `getPrompt('merge')` параллельно.
4. `env.AI.run(model, { messages: [system, user(notesBlock)], max_tokens: 2048 })` без `stream`.
5. Пустой ответ модели → `502 EXTERNAL`.
6. Возвращает `string` — объединённый текст.

### Structurize — Phase 8
Структурирование произвольного текста через LLM.

**Алгоритм** (`structurize.service.ts`):
1. `getActiveModel` + `getPrompt('structurize')` параллельно.
2. Текст обрезается до 50 000 симв.
3. `env.AI.run(model, { messages: [system, user(text)], max_tokens: 4096 })` без `stream`.
4. Пустой ответ модели → `502 EXTERNAL`.
5. Возвращает `{ structured: string }`.

### Suggest Group — Phase 8
RAG-классификация: предлагает топ-K групп по смысловой близости текста заметки к векторам групп.

**Алгоритм** (`suggest-group.service.ts`):
1. Параллельно (`Promise.all`) эмбеддит `noteText` и запрашивает `fetchEmptyGroupIds` (raw D1-запрос по таблицам `groups`/`notes`).
2. `queryGroupVectors(env.VECTORIZE, values, { userId, topK })` — поиск по векторам групп в namespace юзера.
3. Фильтр по `MIN_GROUP_SCORE = 0.3`: хиты ниже порога отбрасываются.
4. Возвращает `{ suggestions: [{ groupId, score }], emptyGroupIds: string[] }`. `emptyGroupIds` — группы без заметок (подсказка «начни использовать»).

`fetchEmptyGroupIds` — soft-fail: при любой ошибке D1 возвращает `[]`.

### Format For Note — Phase 8
Форматирование/обработка диалога для сохранения в заметку. SSE-стрим.

**Алгоритм** (`format-note.service.ts`):
1. `getActiveModel` + `getPrompt('format-note')` параллельно.
2. Сообщения конкатенируются в текст с маркерами `Пользователь:` / `AI:`.
3. `env.AI.run(model, { messages: [system, user(text)], stream: true, max_tokens: 4096 })` → SSE-поток.

## Зависимости

- **D1** (`env.DB`, общая база `notetaker`) → таблицы `settings`, `prompts`.
- **Workers AI** (`env.AI: Ai`) — embedding (`@cf/baai/bge-m3`) и chat (`ALLOWED_MODELS`).
- **Vectorize** (`env.VECTORIZE: VectorizeIndex`, индекс `notetaker-vectors`) — заметки и группы.
- **Service Binding `NOTES`** (`env.NOTES: Fetcher`) — `GET /notes` для develop-suggestions, `GET /notes/:id` для RAG/discuss/merge/suggest-group.
- **Внешние пакеты:** `hono`, `@hono/zod-validator`, `zod`, `drizzle-orm`.

## Routes (через gateway, под JWT-middleware)

**Phase 5B:**
- `POST /ai/search` — body `{ query: string(1..2000), topK?: number(1..50, default 10) }` → `200 [{ noteId, title, score }]`. Семантический поиск с порогом `MIN_SEARCH_SCORE = 0.4`.
- `GET /notes/:id/similar` — query `?topK=N(default 5)` → `200 [{ id, title, score }]`. Похожие заметки. `200 []`, если нет вектора. `404 NOT_FOUND` на чужую/несуществующую заметку. **gateway регистрирует ДО `/notes/:id`** (Hono first-match).

**Phase 5C:**
- `GET /settings` → `200 SettingsView`.
- `PUT /settings/active-model { model: AllowedModel }` → `200 SettingsView`.
- `PUT /settings/prompts/:key { value: string ≤ 8000 }` → `200 SettingsView`.
- `DELETE /settings/prompts/:key` → `204`. Идемпотентно.

**Phase 5D:**
- `POST /ai/summarize` → стрим `text/event-stream`. Body: `{ text: string(100..200000) }`.

**Phase 5F:**
- `GET /ai/develop-suggestions` → `200 [{ noteId, neighbors: [{ noteId, score }] }]`. 0..3 кандидата.

**Phase 5G:**
- `POST /ai/discuss` → стрим `text/event-stream`. Body: `{ noteId: uuid, messages: [{role, content}](1..50) }`. Никогда не отдаёт `502` из-за поломки RAG (graceful degrade).

**Phase 8:**
- `POST /ai/merge` → `200 { result: string }`. Body: `{ activeNoteId: uuid, noteIds: uuid[](1..10) }`. `404` если activeNote или все выбранные недоступны.
- `POST /ai/structurize` → `200 { structured: string }`. Body: `{ text: string(1..50000) }`. `502 EXTERNAL` при пустом ответе модели.
- `POST /ai/suggest-group` → `200 { suggestions: [{ groupId, score }], emptyGroupIds: string[] }`. Body: `{ noteText: string(1..1MB), topK?: number(1..10, default 3) }`.
- `POST /ai/format-for-note` → стрим `text/event-stream`. Body: `{ messages: [{role, content}](1..50) }`.

## Internal endpoints / RPC

**Phase 5B (заметки):**
- `POST /internal/vectors/upsert` — header `x-user-id`, body `{ noteId: uuid, contentText: string(1..1MB) }` → `204`. Вызывается из `notes`-воркера после `POST/PATCH /notes`.
- `POST /internal/vectors/delete` — header `x-user-id`, body `{ noteId: uuid }` → `204`. Вызывается из `notes`-воркера после `DELETE /notes/:id`. Идемпотентно.

**Phase 8 (группы):**
- `POST /internal/vectors/group-upsert` — header `x-user-id`, body `{ groupId: uuid, name: string(1..100), description: string(≤500) }` → `204`. Вызывается из `notes`-воркера после создания/обновления группы.
- `POST /internal/vectors/group-delete` — header `x-user-id`, body `{ groupId: uuid }` → `204`. Вызывается из `notes`-воркера после удаления группы. Идемпотентно.

Internal-эндпоинты не проксируются через gateway. Валидируются Zod. `requireUserId` применяется ко всем `/internal/vectors/*`.

## Services

- `getActiveModel(env) → AllowedModel` *(5A)* — гибрид: D1 → whitelist-проверка → fallback на `DEFAULT_MODEL`.
- `getPrompt(env, key: PromptKey) → string` *(5A)* — гибрид: D1 override → trim → fallback на `DEFAULT_PROMPTS[key]`.
- `listSettings(env) → SettingsView` *(5C)* — snapshot конфигурации без N+1.
- `setActiveModel(env, model) → void` *(5C)* — upsert в `settings.active_model`.
- `setPromptOverride(env, key, value) → void` *(5C)* — upsert в `prompts`.
- `deletePromptOverride(env, key) → void` *(5C)* — DELETE; идемпотентно.
- `embedText(env, text) → number[]` *(5B)* — `env.AI.run(EMBEDDING_MODEL)`. Defensive-проверка `length === EMBEDDING_DIMENSIONS`.
- `upsertNote(env, { noteId, userId, contentText }) → void` *(5B)* — `embedText` → `upsertNoteVector`.
- `deleteNote(env, noteId) → void` *(5B)* — `deleteNoteVectorById`.
- `upsertGroup(env, { groupId, userId, name, description }) → void` *(8)* — `embedText(name + ' ' + description)` → `upsertGroupVector`.
- `deleteGroup(env, groupId) → void` *(8)* — `deleteGroupVectorById`.
- `searchByQuery(env, userId, query, topK) → SearchHit[]` *(5B)* — `embedText` → `queryNoteVectors` → обогащение title через `fetchNoteSummary` (SVC binding `NOTES`) → фильтр по `MIN_SEARCH_SCORE`.
- `findSimilarToNote(env, userId, noteId, topK) → Result<SimilarNoteHit[]>` *(5B)* — cross-user guard через `fetchNoteContentText` → `queryNoteVectorsById` → self-skip → обогащение title.
- `streamSummarize(env, text) → ReadableStream` *(5D)* — `getActiveModel` + `getPrompt('summarize')` параллельно → `env.AI.run(stream:true)`.
- `findDevelopCandidates(env, userId) → DevelopCandidate[]` *(5F)* — `fetchUserNotes` → filter длина < 600 → top-20 → `queryNoteVectorsById` с filter score > 0.65 → group-by groupId → top-1 на тему → top-3.
- `streamDiscuss(env, userId, noteId, messages) → Result<ReadableStream>` *(5G)* — cross-user guard → `Promise.all(getActiveModel, getPrompt, gatherRagContext)` → `env.AI.run(stream:true)`.
- `gatherRagContext(env, userId, noteId) → string[]` *(5G, приватная)* — `queryNoteVectorsById(topK=6)` → self-skip → `Promise.all` по `fetchNoteContentText` → фильтр null.
- `mergeNotes(env, userId, activeNoteId, noteIds) → Result<string>` *(8)* — параллельный fetch текстов → блоки `===Заметка N===` → `env.AI.run` → строка-результат.
- `structurizeNote(env, text) → Result<{structured: string}>` *(8)* — `getActiveModel` + `getPrompt('structurize')` → `env.AI.run` → `{structured}`.
- `suggestGroups(env, userId, noteText, topK) → GroupSuggestResult` *(8)* — параллельно `embedText` + `fetchEmptyGroupIds` → `queryGroupVectors` → фильтр по `MIN_GROUP_SCORE`.
- `streamFormatForNote(env, messages) → ReadableStream` *(8)* — `getActiveModel` + `getPrompt('format-note')` → конкатенация диалога → `env.AI.run(stream:true)`.

## Queries (db/)

- `getSetting(db, key) → Setting | null` *(5A)* — select по PK.
- `setSetting(db, key, value) → void` *(5A)* — upsert через `onConflictDoUpdate`.
- `getPromptOverride(db, key) → PromptOverride | null` *(5A)* — select по PK.
- `listPromptOverrides(db) → PromptOverride[]` *(5C)* — все override'ы разом.
- `setPromptOverride(db, key, value) → void` *(5A)* — upsert.
- `deletePromptOverride(db, key) → void` *(5A)* — DELETE; идемпотентно.
- `vectorIdForNote(noteId) → string` *(5B)* — детерминированный id `note:<uuid>`.
- `upsertNoteVector(index, { noteId, userId, values }) → void` *(5B)* — `Vectorize.upsert` с metadata `{userId, noteId, type:'note', updatedAt}`. namespace = userId.
- `deleteNoteVectorById(index, noteId) → void` *(5B)* — `Vectorize.deleteByIds(['note:<uuid>'])`.
- `queryNoteVectors(index, values, options) → VectorizeMatches` *(5B)* — `Vectorize.query` с двойным guard `namespace + filter:{userId}`.
- `queryNoteVectorsById(index, noteId, options) → VectorizeMatches` *(5B)* — `Vectorize.queryById` с тем же двойным guard.
- `upsertGroupVector(index, { groupId, userId, values }) → void` *(8)* — `Vectorize.upsert` с metadata `{userId, groupId, type:'group', updatedAt}`. namespace = userId.
- `deleteGroupVectorById(index, groupId) → void` *(8)* — `Vectorize.deleteByIds(['group:<uuid>'])`.
- `queryGroupVectors(index, values, options) → VectorizeMatches` *(8)* — `Vectorize.query` в namespace userId с filter `{userId}`.
- `fetchUserNotes(env, userId) → NotesListItem[]` *(5F)* — `env.NOTES.fetch` с `x-user-id`; soft-fail → `[]`.
- `fetchNoteContentText(env, userId, noteId) → string | null` *(5G)* — `env.NOTES.fetch` для RAG; null на 404/403/ошибке.
- `fetchNoteSummary(env, userId, noteId) → {id, title} | null` *(5B)* — `env.NOTES.fetch` для обогащения search-результатов title'ом; null на ошибке.

## Ограничения

- **Только в этом воркере существуют биндинги `env.AI: Ai` и `env.VECTORIZE: VectorizeIndex`** (CLAUDE.md → правила 4, 5).
- **Embedding-модель — константа.** Не меняется через UI (смена = новый индекс + reindex).
- **Whitelist моделей валидируется дважды:** в Zod на роуте и в `getActiveModel` (защита от устаревшей записи в D1).
- **Гибрид настроек глобальный, не на пользователя.**
- **Vectorize в local dev требует `remote: true`** в `wrangler.jsonc`; Workers AI тоже работает только remote.
- **Vectorize требует metadata-index на полях фильтрации.** `wrangler vectorize create-metadata-index notetaker-vectors --property-name=userId --type=string` — обязательный setup-шаг. Для уже записанных векторов индекс пополняется при следующем upsert.
- **JWT не валидируется здесь.** userId приходит заголовком `x-user-id` (CLAUDE.md → правило 11).
- **`/settings/*` не проверяет `x-user-id`** — настройки глобальные; JWT в gateway остаётся guard'ом.
- **Stale-векторы при недоступности ai во время CRUD (known limitation).** Non-blocking `waitUntil` без retry. Восстановление: ручной `POST /internal/vectors/delete` (или `/group-delete`) с нужным id.
