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

### Векторный pipeline F8 — Phase 5B (TBD)
*Ещё не реализовано.* План: `/internal/vectors/upsert`, `/internal/vectors/delete`, `/search`, `/notes/:id/similar` с двойным guard `namespace=userId` + `filter={userId}`.

### Settings F7 — Phase 5C (TBD)
*Ещё не реализовано.* CRUD `/settings/*` для управления `active_model` и `prompts.<key>` через UI.

### Summarize / Classify / Develop / Discuss / Pack — Phase 5D-5G (TBD)
*Ещё не реализовано.*

## Зависимости

- **D1** (`env.DB`, общая база `notetaker`) → таблицы `settings`, `prompts`.
- **Workers AI** (`env.AI: Ai`) — embedding (`@cf/baai/bge-m3`) и chat (`ALLOWED_MODELS`).
- **Vectorize** (`env.VECTORIZE: VectorizeIndex`, индекс `notetaker-vectors`).
- **Внешние пакеты:** `hono`, `@hono/zod-validator`, `zod`, `drizzle-orm`.
- В Phase 5F добавится Service Binding `NOTES` → `notetaker-notes` (для F4 develop-suggestions и F5 discuss RAG).

## Routes (через gateway, под JWT-middleware)

*В Phase 5A публичных роутов нет.* Роуты добавляются по этапам:
- 5B: `POST /ai/search`, `GET /notes/:id/similar`
- 5C: `GET /settings`, `PUT /settings/active-model`, `PUT /settings/prompts/:key`, `DELETE /settings/prompts/:key`
- 5D: `POST /ai/summarize`
- 5E: `POST /ai/classify`
- 5F: `GET /ai/develop-suggestions`
- 5G: `POST /ai/discuss`, `POST /ai/pack-into-project`

## Internal endpoints / RPC

*В Phase 5A internal-эндпоинтов нет (smoke-эндпоинты `/__smoke/*` — временные, удалятся в 5B/5C).* В 5B добавятся `POST /internal/vectors/upsert`, `POST /internal/vectors/delete` (вызываются из notes-воркера через Service Binding `AI` после CRUD заметки).

## Services

- `getActiveModel(env) → AllowedModel` *(5A)* — гибрид: D1 → whitelist-проверка → fallback на `DEFAULT_MODEL`.
- `getPrompt(env, key: PromptKey) → string` *(5A)* — гибрид: D1 override → trim → fallback на `DEFAULT_PROMPTS[key]`.

## Queries (db/)

- `getSetting(db, key) → Setting | null` *(5A)* — select по PK.
- `setSetting(db, key, value) → void` *(5A)* — upsert через `onConflictDoUpdate` (защита от гонки).
- `getPromptOverride(db, key) → PromptOverride | null` *(5A)* — select по PK.
- `setPromptOverride(db, key, value) → void` *(5A)* — upsert.
- `deletePromptOverride(db, key) → void` *(5A)* — DELETE без RETURNING (идемпотентно).

## Ограничения

- **Только в этом воркере существуют биндинги `env.AI: Ai` и `env.VECTORIZE: VectorizeIndex`** (CLAUDE.md → правила 4, 5). Любой другой воркер, которому нужна AI или Vectorize, зовёт ai через Service Binding.
- **Embedding-модель — константа.** Не меняется через UI (CLAUDE.md → «Векторный индекс»: смена = новый индекс + reindex).
- **Whitelist моделей валидируется дважды:** в Zod на роуте `PUT /settings/active-model` (Phase 5C) и в `getActiveModel` (Phase 5A). Защита от устаревшей записи в D1 после редеплоя whitelist'а.
- **Гибрид настроек глобальный, не на пользователя.** `settings.active_model` и `prompts.<key>` влияют на всех. Per-user конфиг — over-engineering для теста.
- **Vectorize в local dev требует `remote: true`** в `wrangler.jsonc` (см. `ai/wrangler.jsonc`); Workers AI тоже работает только remote (CLAUDE.md → «Команды»). Нужен `wrangler login`.
- **JWT не валидируется здесь.** userId приходит заголовком `x-user-id` от gateway (или от notes для internal-эндпоинтов в 5B). CLAUDE.md → правило 11.
- **Smoke-эндпоинты `/__smoke/*`** существуют только в Phase 5A для DoD-проверок; **удаляются** в 5B/5C при появлении настоящих vector- и settings-роутов. Не подключаются к gateway.
