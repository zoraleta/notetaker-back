# notes

CRUD заметок пользователя (F2 backend). Хранит Tiptap-документ, плоский текст для будущих эмбеддингов, привязку к проекту и теги.

## Воркер
`notetaker-notes` — internal-воркер без публичного `routes`. Доступен только через Service Binding `NOTES` из `notetaker-api-gateway`. Имеет SVC binding `AI` → `notetaker-ai` (Phase 5B): после успешного CRUD сервис возвращает `IndexAction`; роут стреляет `c.executionCtx.waitUntil(env.AI.fetch(...))` на `/internal/vectors/upsert` или `/internal/vectors/delete`.

## Логика работы

**Авторизация (общая для GET/:id, PATCH, DELETE):**
1. `findNoteById` без фильтра по userId/deletedAt — нужен сырой документ.
2. Если строки нет или `deletedAt !== null` → `Result.err('not_found', 'NOT_FOUND')` → HTTP 404.
3. Если `note.userId !== userId` → `Result.err('forbidden', 'FORBIDDEN')` → HTTP 403.
4. Иначе работаем с заметкой.

Различие 404/403 продиктовано требованием: фронт по прямой ссылке на чужой `id` должен видеть «нет доступа» (403), а на несуществующий — «нет такой заметки» (404). Tech-plan DoD это разрешает.

**Создание (`POST /notes`):**
1. Zod-валидация: `contentJson` (объект, любой Tiptap-документ), `contentText` (строка ≤ 1 МБ), опционально `title` (≤ 500), `projectId` (string|null), `tags` (массив строк, ≤ 20 шт, каждая ≤ 64 симв).
2. Генерация `id = crypto.randomUUID()`, `createdAt/updatedAt = now`, `deletedAt = null`, `isIndexedAt = null`.
3. `insertNote` (`returning()`).
4. Сервис возвращает `{ note, index: { kind: 'upsert', userId, noteId, contentText, projectId } }`.
5. Роут: фронту отдаёт только `note` (`201`), затем `triggerVectorIndex(c, index)` стреляет `c.executionCtx.waitUntil` для индексации в Vectorize в фоне.

**Список (`GET /notes`):**
1. Zod-валидация query: `projectId?`, `tag?` — оба опциональны.
2. `listNotesByUser`: фильтр `userId = ? AND deletedAt IS NULL`, плюс опциональные `projectId = ?` и `EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)`.
3. Сортировка `updatedAt DESC` (свежие сверху). Пагинации нет — для теста достаточно (CLAUDE.md → YAGNI).
4. Ответ `200 Note[]`.

**Получение одной (`GET /notes/:id`):**
1. Zod-валидация param: `id` — UUID.
2. `authoriseNote` → 200/403/404.

**Обновление (`PATCH /notes/:id`):**
1. Zod-валидация param и body. Body — любое подмножество `{ title, contentJson, contentText, projectId, tags }`, но не пустое (`refine`).
2. `authoriseNote`.
3. `updateNoteFields`: `set` собирается динамически из заданных полей, `updatedAt = now` ставится всегда.
4. Сервис возвращает `{ note, index: { kind: 'upsert', ... } }` (re-upsert использует тот же id вектора, обновляет embedding/metadata).
5. Роут: `200 Note` + `triggerVectorIndex(c, index)`. На PATCH всегда шлём upsert, даже если изменился только `title`/`tags` — micro-оптимизация по diff не стоит сложности.

**Удаление (`DELETE /notes/:id`):**
1. Zod-валидация param.
2. `authoriseNote`.
3. `softDeleteNote`: `set deletedAt = now, updatedAt = now`. Реальная строка остаётся в D1 (для будущего восстановления).
4. Сервис возвращает `{ index: { kind: 'delete', userId, noteId } }`.
5. Роут: `204 No Content` + `triggerVectorIndex(c, index)` — вектор удаляется из Vectorize по тому же `note:<uuid>`-id.

**`x-user-id` (`requireUserId` middleware):**
1. Считывается из заголовка, который ставит gateway после JWT-проверки.
2. Пустой / отсутствует → `401 UNAUTHORIZED` (это означает, что gateway вызвал воркер в обход своей цепочки — баг конфигурации).
3. Кладётся в Hono `Variables` как `userId`.

JWT здесь не валидируется (CLAUDE.md → правило 11).

## Зависимости

- **D1** (`env.DB`, общая база `notetaker`) → таблица `notes`.
- **Service Binding `AI`** (`env.AI: Fetcher` → `notetaker-ai`) — для фоновой индексации заметки в Vectorize после успешного CRUD (Phase 5B). Вызовы идут через `c.executionCtx.waitUntil` без `await` — фон не блокирует ответ юзеру.
- **Внешние пакеты:** `hono`, `@hono/zod-validator`, `zod`, `drizzle-orm`.

## Routes (через gateway, под `/notes/*` + JWT middleware)
- `POST /notes` — `{ title?, contentJson, contentText, projectId?, tags? }` → `201 Note`.
- `GET /notes` — `?projectId=…&tag=…` (оба опциональны) → `200 Note[]`, sort `updatedAt DESC`.
- `GET /notes/:id` — UUID → `200 Note` / `403 FORBIDDEN` / `404 NOT_FOUND`.
- `PATCH /notes/:id` — любое подмножество полей, ≥1 → `200 Note` / `400` / `403` / `404`.
- `DELETE /notes/:id` — soft-delete → `204` / `403` / `404`.

## Internal endpoints / RPC
Те же пути, что выше — gateway проксирует «как есть» (префиксы совпадают, `proxyToService` не переписывает URL). Других internal-эндпоинтов нет.

С Phase 5F/5G к этим же путям обращается **ai-воркер** через свой SVC binding `NOTES`: `GET /notes` для F4 develop-suggestions (см. `docs/modules/ai.md` секция Develop F4), `GET /notes/:id` для RAG-контекста F5 discuss (секция Discuss F5). Контракт идентичен фронтовому: `x-user-id` в заголовке, JSON-ответ. Поэтому никаких отдельных internal-routes для ai не заводим — переиспользуем те же эндпоинты.

## Services
- `createNote(env, userId, input) → Result<NoteMutationResult>` — генерирует id, ставит `createdAt/updatedAt`, дефолтит `tags: []`, `projectId: null`, `title: ''`. Insert через `db/notes.queries.insertNote`. Возвращает `{ note, index: 'upsert' }`.
- `listNotes(env, userId, filters) → Result<Note[]>` — обёртка над `listNotesByUser` (фильтр по `deletedAt IS NULL` уже внутри). Без index — список ничего не индексирует.
- `getNote(env, userId, id) → Result<Note>` — через `authoriseNote`. Без index — read-only.
- `updateNote(env, userId, id, input) → Result<NoteMutationResult>` — `authoriseNote` → `updateNoteFields(updatedAt = now)`. Возвращает `{ note, index: 'upsert' }`.
- `deleteNote(env, userId, id) → Result<DeleteMutationResult>` — `authoriseNote` → `softDeleteNote(deletedAt = now)`. Возвращает `{ index: 'delete' }` (без note — фронту 204).
- `authoriseNote(env, id, userId) → Result<Note>` — единый источник правды по 404/403 (приватная для модуля).

`IndexAction = { kind: 'upsert' | 'delete', userId, noteId, ...payload }` — discriminated union, который ловит роут и передаёт в `triggerVectorIndex`. Сервис остаётся HTTP-agnostic (CLAUDE.md правило 2): не принимает `ExecutionContext`, не зовёт `env.AI.fetch` сам.

## Queries (db/)
- `insertNote(db, note) → Note` — insert + `returning()`.
- `findNoteById(db, id) → Note | null` — без фильтра по userId/deletedAt; для авторизации в сервисе.
- `listNotesByUser(db, userId, filters) → Note[]` — `userId = ? AND deletedAt IS NULL`, опциональные `projectId = ?` и `EXISTS (json_each(tags) WHERE value = ?)`, sort `updatedAt DESC`.
- `updateNoteFields(db, id, patch) → Note` — динамический `set` только из заданных полей + всегда `updatedAt`.
- `softDeleteNote(db, id, deletedAt) → void` — `set deletedAt, updatedAt`.

## Ограничения

- **Нет публичного `routes` в `wrangler.jsonc`.** Internal-only (CLAUDE.md → правило 1).
- **Нет JWT-middleware.** Только `x-user-id` из gateway (CLAUDE.md → правило 11).
- **Нет AI/Vectorize биндингов** (`[ai]`, `[[vectorize]]`) — это запрещено в любом воркере, кроме `ai` (CLAUDE.md → правила 4, 5). Notes общается с `ai` только через **Service Binding `AI`** (`env.AI: Fetcher` → `notetaker-ai`), вызывая публичный/internal HTTP-контракт ai-воркера (`/internal/vectors/upsert`, `/internal/vectors/delete`). CLAUDE.md правило 9 это разрешает.
- **Нет FK на `users`/`projects`.** D1 + микросервисы: целевые таблицы живут в других воркерах, FK через границу binding всё равно не работает. Целостность поддерживается логически (gateway гарантирует валидный `userId`; для `projectId` ссылочная целостность появится в Phase 7 при удалении проекта — `projects` обнулит `projectId` через SVC binding).
- **`contentJson` не парсится на бэке.** Принимается как объект, хранится в `text` колонке через Drizzle `mode: 'json'`. Извлечение plain-текста для эмбеддингов — обязанность фронта (поле `contentText`).
- **Лимиты:** `title ≤ 500`, `contentText ≤ 1 МБ`, `tags ≤ 20 элементов`, `tag ≤ 64 симв`. Workers имеет жёсткий потолок 100 МБ на тело — наши лимиты сильно ниже, чтобы не упереться в Workers AI / Vectorize при индексации.
- **Soft-delete необратим со стороны API.** Эндпоинта восстановления нет. Сама строка остаётся в БД, чтобы в будущем (или через ручную SQL-операцию) можно было восстановить.
- **`isIndexedAt` остаётся `null` на Phase 5B.** Обновление флага потребовало бы обратной петли `ai → notes` через SVC binding `NOTES` в ai (ради отладочной метаданной). YAGNI: реальной потребности (mass-reindex) нет — добавим, когда появится.
- **Без retry-обёртки на `waitUntil`.** Если ai-воркер упал на конкретной фоновой индексации — CRUD заметки уже успешен, юзер ничего не теряет; ошибка уйдёт в `wrangler tail`. Mass-reindex как admin-операция = за рамками Phase 5.
- **Нет пагинации `GET /notes`.** Возвращает все живые заметки пользователя. Для теста (десятки заметок) хватит; при росте — добавлять `?limit&offset` или cursor-pagination отдельным шагом.
- **Тег-фильтр требует SQLite ≥ 3.38** (для `json_each`). Cloudflare D1 — современный SQLite, ограничение не актуально, но при миграции на другой движок придётся пересмотреть.
