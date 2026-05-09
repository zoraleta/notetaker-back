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

### Settings F7 — Phase 5C
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
- `default` — из `DEFAULT_PROMPTS` (whitelist в коде).
- `override` — сырая запись из D1 (`null`, если нет).
- `effective` — что реально пойдёт в LLM (override после trim, иначе default).

**Запись:**
- `PUT /settings/active-model { model }` — Zod-проверка `model` по `z.enum(ALLOWED_MODELS)`. Невалидное значение → `400 VALIDATION` с сообщением Zod (whitelist не раскрывается клиенту, но `GET /settings.allowedModels` его уже отдаёт).
- `PUT /settings/prompts/:key { value }` — Zod-проверка `key` по `z.enum(Object.keys(DEFAULT_PROMPTS))`; `value` — `string ≤ 8000` симв., `trim().length ≥ 1`. Пробельная строка → `400 VALIDATION`.
- `DELETE /settings/prompts/:key` — Zod-проверка `key`. Идемпотентно: повторный DELETE → `204` даже если записи не было.

**Возврат:** `PUT` отвечает свежим `SettingsView` (как `GET /settings`) — фронт не делает вторичный round-trip. `DELETE` отвечает `204`.

**Глобальность.** Записи в `settings`/`prompts` — **на инстанс**, не на пользователя. Per-user override не реализован (over-engineering для теста; см. tech-plan §«Гибрид config + D1»). Поэтому на роутах `/settings/*` нет `requireUserId` — JWT остаётся в gateway как guard на уровень «авторизован ли вообще», но userId внутрь ai не пробрасывается семантически.

### Summarize F1 — Phase 5D
Стриминг саммари статьи через Workers AI с `stream: true`. Активная модель и системный промпт читаются из гибрида config+D1 (`getActiveModel`/`getPrompt`), поэтому смена через `/settings/*` применяется к следующему запросу без редеплоя.

**Поток:**
1. Роут валидирует `text: 100..200000` симв. через Zod.
2. `streamSummarize(env, text)` параллельно (`Promise.all`) тянет активную модель и промпт `summarize`.
3. `env.AI.run(model, { messages: [system, user], stream: true })` — единственный вызов; возвращает `ReadableStream<Uint8Array>` уже в формате SSE (`data: {...}\n\n` + `data: [DONE]\n\n`). Воркер не парсит и не оборачивает поток — отдаёт как `text/event-stream` с `cache-control: no-cache`.
4. Hono в gateway пропускает Response с `ReadableStream` без буферизации (`authenticatedProxy` возвращает `target.fetch(...)` напрямую). Фронт получает токены посимвольно.

**Без `requireUserId`.** Саммари — чистая трансформация text-in/text-out: ни D1, ни Vectorize, ни знания о юзере. JWT в gateway остаётся guard'ом «авторизован — может дёргать LLM».

**Лимиты длины (`100..200000`):** `< 100` — суммировать нечего; `> 200 000` — приближение к контекстному окну небольших моделей и предохранитель от случайного спама. Реальный токен-лимит проверит сама Workers AI (вернёт ошибку модели → `app.onError` → 500).

### Classify F3 — Phase 5E
RAG-классификация заметки по соседям в Vectorize: фронт получает suggestion `projectId | null` синхронно при создании заметки (не часть `waitUntil` — нужен ответ в UI).

**Алгоритм** (`classify.service.ts`):
1. Эмбеддим `contentText` через bge-m3.
2. `VECTORIZE.query(topK=20)` в namespace юзера + `filter: { userId }` (двойной guard).
3. Скипаем `NO_PROJECT`-соседей: заметки без проекта в голосовании не участвуют, иначе любой текст «голосовал бы» за мажоритарный класс «без проекта».
4. **Per-neighbor min-score filter** (`MIN_NEIGHBOR_SCORE = 0.45`): отбрасываем соседей со score ниже порога, чтобы шум не накапливался в сумму. Эмпирика на bge-m3 для русских коротких текстов: ~0.20-0.35 — «не связано», ~0.35-0.45 — «слабо связано», 0.45+ — «по теме».
5. Суммируем выжившие score по `projectId`.
6. Берём `projectId` с максимальной суммой. Если сумма > `SCORE_THRESHOLD = 0.75` — отдаём `{ projectId, score }`, иначе `{ projectId: null }`.

**Решение по центроидам.** Tech-plan §5.5 предлагает «лениво через top-K соседей» вместо хранения центроидов отдельно. Принимаем как есть — нет новой таблицы, достаточно для F3.

**Решение по noise filter.** Спецификация Phase 5E указывает «сумма score, threshold 0.75». На реальных данных без фильтра рецепт-запрос на DB из 5 IT-заметок набирает sum=1.5+ (5 слабых соседей по 0.3) и ложно классифицируется. `MIN_NEIGHBOR_SCORE = 0.45` устраняет это, сохраняя спец-семантику суммы и threshold 0.75.

**Empirical scores** (DoD smoke):
- X-query на DB(5 X-notes + 5 Y-notes) → sum 2.6 → suggestion `proj-cloudflare`.
- Y-query на той же DB → все X-соседи ниже 0.45 → sum 0 → `null`.
- Cross-user Bob (пустой namespace) → нет соседей → `null`.

### Develop F4 — Phase 5F
Дашборд показывает 2-3 коротких заметки, у которых есть похожие соседи — кандидаты «дописать/развить тему».

**Алгоритм** (`develop.service.ts`):
1. Через SVC binding `NOTES` ai зовёт `GET /notes` (тот же эндпоинт, что у фронта). Заголовок `x-user-id` пробрасывается. notes возвращает массив, отсортированный `updatedAt DESC`.
2. Фильтр по длине: `contentText < SHORT_NOTE_MAX = 600`.
3. Берём первые `CANDIDATE_LIMIT = 20` (анти-DoS на больших коллекциях; свежие сверху достаточны для UI «что недавно недописал»).
4. Для каждого кандидата `VECTORIZE.queryById(topK = NEIGHBORS_TOPK + 1)` в namespace юзера + `filter: { userId }` (двойной guard). Self исключаем, соседей со `score < NEIGHBOR_SCORE_MIN = 0.65` отбрасываем. Если ни одного соседа не осталось — кандидат не попадает в результат.
5. **Theme-deduplication**: группируем кандидатов по `projectId` (NO_PROJECT — отдельный bucket `__none__`), оставляем top-1 в каждой группе по числу соседей (тай-брейкер — свежесть, благодаря `updatedAt DESC` входной сортировке + first-set-wins логике в `Map`). Без dedup тема с большим числом коротких заметок съедает все слоты suggestions; с dedup юзер видит вариативность тем.
6. Сортируем дедуплицированный список по числу соседей desc, берём top `SUGGESTIONS_LIMIT = 3`.

**Решение по cross-worker SVC.** ai зовёт notes через `env.NOTES.fetch` — это второй случай межворкерного SVC binding в системе после notes → ai (Phase 5B). Архитектурно симметрично, CLAUDE.md правило 8 разрешает. Альтернатива «gateway сам зовёт notes и передаёт список в ai» — менее чисто, gateway не должен знать форму notes-payload.

**Soft-fail.** Если notes-воркер упал, `fetchUserNotes` возвращает `[]` → ai отдаёт `[]` → фронт скрывает блок suggestions. Не возвращаем 502 для всего F4: дашборд должен загрузиться даже при поломке одного из микросервисов.

**Empirical scores** (DoD smoke на 2 X-cloudflare-shorts (Service Bindings) + 3 Y-cooking-shorts (борщ) + 5 long music notes): 2 кандидата (1 X + 1 Y, по одному на тему); long-IDs не попали; cross-user Bob → `[]`.

### Discuss F5 — Phase 5G
Стриминг чата с RAG-контекстом из соседних заметок юзера. На вход — `noteId` (заметка-якорь) и история сообщений; на выход — SSE-поток ответа модели, с подмешанным контекстом из других заметок того же юзера.

**Алгоритм** (`discuss.service.ts`):
1. Параллельно (`Promise.all`) тянем активную модель, промпт `discuss` и RAG-контекст. RAG — самая медленная цепочка (queryById + N×GET notes), не дожидаемся последовательно.
2. RAG-сборка (`gatherRagContext`):
   - `VECTORIZE.queryById('note:'+noteId, { topK: RAG_TOPK + 1, filter: { userId } })` (двойной guard namespace+filter; `+1` под self).
   - Self-skip + сбор первых `RAG_TOPK = 5` соседних `noteId`.
   - `Promise.all` по `fetchNoteContentText(env, userId, id)` — N×`GET /notes/:id` через SVC binding `NOTES`. Параллельно, не последовательно: SVC binding — это прямой вызов JS-функции в одном runtime, миллисекунды на запрос.
   - Фильтруем `null` (404/403/network-fail/невалидный JSON) и пустые строки.
3. Сборка `messages`: `[systemPrompt, ragBlock?, ...userMessages]`. RAG — отдельным `system`-блоком, **не** конкатенацией с основным промптом (антипаттерн «шаблонные строки промптов с `${variables}` снаружи `getPrompt`»). Маркеры `===Заметка N===` отделяют контекст-блоки, чтобы модель не путала их с инструкциями.
4. `env.AI.run(model, { messages, stream: true })` — SSE-поток отдаётся «как есть» через gateway без буферизации.

**Graceful degrade RAG.** Три уровня поломки, ни один не возвращает 502:
- У заметки-якоря нет вектора (только что создана, индексация в фоне) → `queryById` вернёт пустой `matches` → RAG = `[]` → ответ без контекста.
- k из N соседей падают на `GET /notes/:id` (soft-delete между `queryById` и `fetch`, или notes-воркер недоступен) → `fetchNoteContentText` вернёт `null` для проблемных id → `filter` отбросит null'ы → RAG из (N-k) удачных.
- Все N соседей упали → RAG = `[]` → ответ без контекста.

Cross-user изоляция работает «бесплатно»: namespace=userId в `queryById` означает, что Bob с Alice'ин `noteId` получает пустой `matches` (вектор не лежит в Bob'овом namespace) → RAG=[] → стрим без leak'а Alice'иных данных. Дополнительный 403/404 от notes для якорной заметки не делаем — namespace-guard достаточен, лишний SVC-вызов на каждый `/discuss` не нужен.

**Empirical scores** (DoD smoke на 6 alice TS-заметках):
- Полный RAG (5 соседей) → `prompt_tokens=403`, ответ перечисляет всё из RAG (discriminated unions, const assertions, type narrowing/guards, extends, utility types Pick/Omit/Partial).
- После soft-delete одной соседней → `prompt_tokens=345` (4 RAG), ответ полный без 502 = graceful degrade.
- Bob с Alice'иным noteId → `prompt_tokens=101` (без RAG), модель отвечает «нужен доступ к заметкам» = cross-user изоляция.

### Pack-into-project F5 — Phase 5G
Структурированная упаковка диалога в проект для Phase 7. Без стрима: ждём полный ответ модели, парсим JSON, валидируем по Zod-схеме. На выход — `{ goal, stages: [{title, done}], openQuestions }` или `502 EXTERNAL` при поломке формата.

**Алгоритм** (`pack.service.ts`):
1. Параллельно тянем активную модель и промпт `pack-into-project`.
2. `env.AI.run(model, { messages: [system, user(dialog)] })` без `stream` — нужен полный ответ для JSON.parse.
3. `extractJsonBlock(raw)` — substring от первого `{` до последнего `}`. Llama 3.1/3.3 в практике 5G smoke возвращают либо чистый JSON, либо с минимальной markdown-обвязкой (` ```json `…` ``` `, преамбула «Вот ответ:»). Если LLM вернёт строго JSON — substring совпадёт со входом.
4. `JSON.parse` → провал → `Result.err('Не удалось распарсить ответ модели', 'EXTERNAL')` → `502`.
5. `projectPackSchema.safeParse` (Zod) → провал → `Result.err('Ответ модели не соответствует ожидаемой схеме проекта', 'EXTERNAL')` → `502`.
6. Успех → `200 ProjectPack`.

**Жёсткая Zod-валидация поверх `JSON.parse`** — потому что модель может вернуть валидный JSON (`JSON.parse` пройдёт), но с лишними/неправильными полями (`{"foo":"bar"}`). Без Zod-проверки фронт получит мусор без понятной ошибки. `safeParse` ловит оба случая (некорректный JSON И неправильную форму) одним механизмом.

**Без `sourceNoteId`.** Спека предлагала optional `sourceNoteId` для возможной дополнительной RAG-контекстуализации, но на DoD это не используется — YAGNI (CLAUDE.md). Если когда-нибудь pack начнёт использовать контекст исходной заметки, добавим тогда.

**Empirical** (DoD smoke):
- Happy path → 200 с полным `{goal, stages, openQuestions}`.
- Override prompt'а на «верни строку без скобок» → 502 «Не удалось распарсить ответ модели».
- Override prompt'а на `{"foo":"bar","baz":42}` → 502 «Ответ модели не соответствует ожидаемой схеме проекта» (Zod ловит).

## Зависимости

- **D1** (`env.DB`, общая база `notetaker`) → таблицы `settings`, `prompts`.
- **Workers AI** (`env.AI: Ai`) — embedding (`@cf/baai/bge-m3`) и chat (`ALLOWED_MODELS`).
- **Vectorize** (`env.VECTORIZE: Vectorize`, индекс `notetaker-vectors`).
- **Service Binding `NOTES`** (`env.NOTES: Fetcher`) — `GET /notes` для F4 develop-suggestions (Phase 5F) и `GET /notes/:id` для RAG-контекста F5 discuss (Phase 5G).
- **Внешние пакеты:** `hono`, `@hono/zod-validator`, `zod`, `drizzle-orm`.

## Routes (через gateway, под JWT-middleware)

**Реализовано (Phase 5B):**
- `POST /ai/search` — body `{ query: string(1..2000), topK?: number(1..50, default 10) }` → `200 [{ noteId, score, projectId: string|null }]`. Семантический поиск по эмбеддингу запроса в namespace юзера.
- `GET /notes/:id/similar` — query `?topK=N(default 5)` → `200 [{ noteId, score, projectId }]`. Похожие заметки по эмбеддингу указанной заметки (self исключён). `200 []`, если у заметки ещё нет вектора. **gateway регистрирует этот роут ДО `/notes/:id`** (Hono first-match), чтобы `/:id` не поглотил `/:id/similar`.

**Реализовано (Phase 5C):**
- `GET /settings` → `200 SettingsView` (см. секцию «Settings F7» выше). Без тела.
- `PUT /settings/active-model { model: AllowedModel }` → `200 SettingsView`. Невалидная модель → `400 VALIDATION`.
- `PUT /settings/prompts/:key { value: string ≤ 8000 }` → `200 SettingsView`. Невалидный `key` или пробельный `value` → `400 VALIDATION`.
- `DELETE /settings/prompts/:key` → `204`. Невалидный `key` → `400 VALIDATION`. Идемпотентно.

**Реализовано (Phase 5D):**
- `POST /ai/summarize` → стрим `text/event-stream` (SSE, формат Workers AI `data: {response, p, ...}\n\n` + `data: [DONE]\n\n`). Body: `{ text: string(100..200000) }`. Невалидная длина → `400 VALIDATION`. Без JWT → `401` (gateway).

**Реализовано (Phase 5E):**
- `POST /ai/classify` → `200 { projectId: string | null, score: number | null }`. Body: `{ contentText: string(1..1MB) }`. Однообразный shape: при suggestion'е оба поля заполнены (`score` — сумма cosine), при отсутствии suggestion'а оба `null`. Без JWT → `401`. Empty body → `400 VALIDATION`.

**Реализовано (Phase 5F):**
- `GET /ai/develop-suggestions` → `200 [{ noteId, neighbors: [{ noteId, score }] }]`. Без тела/query. Возвращает 0..3 кандидата (короткие заметки с соседями выше threshold), один на тему благодаря theme-dedup. Если у юзера нет коротких или ни одного соседа выше 0.65 — `[]`. Без JWT → `401`.

**Реализовано (Phase 5G):**
- `POST /ai/discuss` → стрим `text/event-stream` (формат Workers AI, как у `/summarize`). Body: `{ noteId: uuid, messages: [{role:'user'|'assistant', content: string(1..8000)}](1..50) }`. RAG-контекст подмешивается отдельным system-блоком из топ-5 соседей по Vectorize (через SVC binding `NOTES` для текстов). Невалидный body → `400 VALIDATION`. Без JWT → `401`. Никогда не отдаёт `502` из-за поломки RAG (graceful degrade).
- `POST /ai/pack-into-project` → `200 { goal: string, stages: [{title, done}], openQuestions: string[] }`. Body: `{ dialog: string(1..100000) }`. Невалидный JSON / неправильная форма ответа модели → `502 EXTERNAL` с осмысленным сообщением. Невалидный body → `400 VALIDATION`. Без JWT → `401`.

## Internal endpoints / RPC

**Реализовано (Phase 5B):**
- `POST /internal/vectors/upsert` — header `x-user-id`, body `{ noteId: uuid, contentText: string(1..1MB), projectId: string|null }` → `204`. Вызывается из `notes`-воркера через SVC binding `AI` после успешного `POST /notes` или `PATCH /notes/:id`.
- `POST /internal/vectors/delete` — header `x-user-id`, body `{ noteId: uuid }` → `204`. Вызывается из `notes`-воркера после успешного `DELETE /notes/:id` (soft-delete в D1). Идемпотентно — удаление несуществующего вектора не падает.

Internal-эндпоинты **не проксируются через gateway** (фронту недоступны). Валидируются Zod (internal ≠ untrusted). `requireUserId` middleware применяется ко всем `/internal/vectors/*`.

## Services

- `getActiveModel(env) → AllowedModel` *(5A)* — гибрид: D1 → whitelist-проверка → fallback на `DEFAULT_MODEL`.
- `getPrompt(env, key: PromptKey) → string` *(5A)* — гибрид: D1 override → trim → fallback на `DEFAULT_PROMPTS[key]`.
- `listSettings(env) → SettingsView` *(5C)* — snapshot всей AI-конфигурации (activeModel + prompts с default/override/effective + embedding-константы + allowedModels). Один проход по `listPromptOverrides`, без N+1 на ключ.
- `setActiveModel(env, model: AllowedModel) → void` *(5C)* — upsert в `settings.active_model`. Whitelist валидируется на роуте Zod-ом; в сервис попадает уже типизированное значение.
- `setPromptOverride(env, key: PromptKey, value: string) → void` *(5C)* — upsert в `prompts`. `key` whitelist'ится на роуте; `value` ожидается уже trim'нутым непустым.
- `deletePromptOverride(env, key: PromptKey) → void` *(5C)* — DELETE; идемпотентно.
- `embedText(env, text) → number[]` *(5B)* — единственное место, которое зовёт `env.AI.run(EMBEDDING_MODEL)`. Defensive-проверка `length === EMBEDDING_DIMENSIONS`, иначе throw → 500.
- `upsertNote(env, { noteId, userId, contentText, projectId }) → void` *(5B)* — `embedText` → `db/upsertNoteVector`.
- `deleteNote(env, noteId) → void` *(5B)* — `db/deleteNoteVectorById`.
- `searchByQuery(env, userId, query, topK) → SearchHit[]` *(5B)* — `embedText` → `queryNoteVectors` → маппинг через `toSearchHit` (NO_PROJECT → null).
- `findSimilarToNote(env, userId, noteId, topK) → SearchHit[]` *(5B)* — `queryNoteVectorsById` с `topK+1`, выкидывает self, мапит. `[]`, если вектора нет.
- `streamSummarize(env, text) → ReadableStream` *(5D)* — параллельно достаёт `getActiveModel` и `getPrompt('summarize')`, зовёт `env.AI.run(model, { messages, stream: true })`, отдаёт сырой SSE-поток без обёртки.
- `classifyNote(env, userId, contentText) → ClassifyResult` *(5E)* — embed → `queryNoteVectors(topK=20)` → per-neighbor min-score filter (0.45) → sum по projectId (NO_PROJECT исключён) → max-sum > 0.75 → suggestion / null.
- `findDevelopCandidates(env, userId) → DevelopCandidate[]` *(5F)* — `env.NOTES.fetch('GET /notes')` → filter длина < 600 → top-20 свежих → `queryNoteVectorsById` для каждого с фильтром score > 0.65 → group-by projectId → top-1 на тему → top-3 по числу соседей. Soft-fail на падении notes (возвращает `[]`).
- `streamDiscuss(env, userId, noteId, messages) → ReadableStream` *(5G)* — параллельно `Promise.all` достаёт `getActiveModel`, `getPrompt('discuss')` и RAG-контекст; собирает `messages: [system, ragBlock?, ...userMessages]`; `env.AI.run(model, { messages, stream: true })` → сырой SSE-поток.
- `gatherRagContext(env, userId, noteId) → string[]` *(5G, приватная)* — `queryNoteVectorsById(topK=6)` → self-skip → первые 5 соседних `noteId` → `Promise.all` по `fetchNoteContentText` через SVC binding `NOTES` → фильтр `null` (graceful degrade на 404/403/network-fail). Возвращает 0..5 текстов.
- `packDialogIntoProject(env, dialog) → Result<ProjectPack>` *(5G)* — `getActiveModel` + `getPrompt('pack-into-project')` параллельно → `env.AI.run` без `stream` → `extractJsonBlock` (substring `{...}` для случаев markdown-обёртки) → `JSON.parse` → `projectPackSchema.safeParse` (Zod). Любая поломка парсинга/формы → `Result.err(..., 'EXTERNAL')` → `502`.

## Queries (db/)

- `getSetting(db, key) → Setting | null` *(5A)* — select по PK.
- `setSetting(db, key, value) → void` *(5A)* — upsert через `onConflictDoUpdate` (защита от гонки).
- `getPromptOverride(db, key) → PromptOverride | null` *(5A)* — select по PK.
- `listPromptOverrides(db) → PromptOverride[]` *(5C)* — все override'ы разом (для `listSettings`, без фильтра).
- `setPromptOverride(db, key, value) → void` *(5A)* — upsert.
- `deletePromptOverride(db, key) → void` *(5A)* — DELETE без RETURNING (идемпотентно).
- `vectorIdForNote(noteId) → string` *(5B)* — детерминированный id `note:<uuid>`.
- `upsertNoteVector(index, args) → void` *(5B)* — `Vectorize.upsert` с metadata `{userId, noteId, projectId, type, updatedAt}`. namespace = userId.
- `deleteNoteVectorById(index, noteId) → void` *(5B)* — `Vectorize.deleteByIds`.
- `queryNoteVectors(index, values, options) → VectorizeMatches` *(5B)* — `Vectorize.query` с двойным guard `namespace + filter:{userId}`.
- `queryNoteVectorsById(index, noteId, options) → VectorizeMatches` *(5B)* — `Vectorize.queryById` с тем же двойным guard.
- `fetchUserNotes(env, userId) → NotesListItem[]` *(5F)* — `env.NOTES.fetch('https://internal/notes')` с пробросом `x-user-id`; soft-fail на любой поломке (5xx/невалидный JSON/дрейф shape) → `[]`.
- `fetchNoteContentText(env, userId, noteId) → string | null` *(5G)* — `env.NOTES.fetch('https://internal/notes/<id>')`; null на 404/403/network-fail/невалидный JSON. Используется в `gatherRagContext` для F5 discuss с graceful degrade.

## Ограничения

- **Только в этом воркере существуют биндинги `env.AI: Ai` и `env.VECTORIZE: Vectorize`** (CLAUDE.md → правила 4, 5). Любой другой воркер, которому нужна AI или Vectorize, зовёт ai через Service Binding.
- **Embedding-модель — константа.** Не меняется через UI (CLAUDE.md → «Векторный индекс»: смена = новый индекс + reindex).
- **Whitelist моделей валидируется дважды:** в Zod на роуте `PUT /settings/active-model` (Phase 5C) и в `getActiveModel` (Phase 5A). Защита от устаревшей записи в D1 после редеплоя whitelist'а.
- **Гибрид настроек глобальный, не на пользователя.** `settings.active_model` и `prompts.<key>` влияют на всех. Per-user конфиг — over-engineering для теста.
- **Vectorize в local dev требует `remote: true`** в `wrangler.jsonc` (см. `ai/wrangler.jsonc`); Workers AI тоже работает только remote (CLAUDE.md → «Команды»). Нужен `wrangler login`.
- **Vectorize требует metadata-index на полях, по которым идёт `filter`.** Без `wrangler vectorize create-metadata-index notetaker-vectors --property-name=userId --type=string` запрос с `filter: { userId }` возвращает пустой результат — даже если namespace совпадает и вектор существует. Это **обязательный setup-шаг** для прода (одноразово), и для уже записанных векторов индекс пополняется только при следующем upsert (Cloudflare-конвенция). Список текущих индексов: `wrangler vectorize list-metadata-index notetaker-vectors`.
- **JWT не валидируется здесь.** userId приходит заголовком `x-user-id` от gateway (или от notes для internal-эндпоинтов в 5B). CLAUDE.md → правило 11.
- **Настройки глобальные на инстанс, не на пользователя.** `settings.active_model` и `prompts.<key>` влияют на всех (CLAUDE.md → «Настройки AI: гибрид config + D1»). Поэтому `/settings/*` в ai не проверяет `x-user-id`. JWT в gateway остаётся guard'ом «авторизован — значит может править».
- **`PUT /settings/active-model` и `PUT /settings/prompts/:key` отвечают свежим `SettingsView`**, чтобы фронт не делал лишний `GET /settings` после записи.
- **Stale-векторы при недоступности ai во время `DELETE /notes/:id` (known limitation).** notes-воркер делает `c.executionCtx.waitUntil(env.AI.fetch('/internal/vectors/delete'))` — non-blocking, без retry (CLAUDE.md Phase 5 решение #7). Если ai в этот момент недоступен (в dev — hot-reload, в проде — крайне редко), запись в D1 уйдёт в soft-delete, а вектор останется в Vectorize навсегда. Эффект: orphan-вектор может проявиться как «фантомный сосед» в `/search`/`/notes/:id/similar`/`/classify`/`/develop-suggestions`. **Восстановление:** ручной вызов `POST /internal/vectors/delete` с нужным `noteId` (через wrangler-fetch или admin-обвязку). Полноценное решение — admin endpoint mass-reindex — за рамками Phase 5 (CLAUDE.md «Векторный индекс»).
