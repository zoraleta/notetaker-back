# notes

CRUD заметок и групп пользователя. Хранит Tiptap-документ, плоский текст для эмбеддингов, привязку к группе и теги. Содержит таблицы `notes` и `groups`.

## Воркер
`notetaker-notes` — internal-воркер без публичного `routes`. Доступен только через Service Binding `NOTES` из `notetaker-api-gateway`. Имеет SVC binding `AI` → `notetaker-ai` (Phase 5B / Phase 8): после успешного CRUD заметки сервис возвращает `IndexAction`; после успешного CRUD группы — `GroupIndexAction`; роут стреляет `c.executionCtx.waitUntil(env.AI.fetch(...))` на соответствующий `/internal/vectors/*`-эндпоинт.

## Логика работы

**Авторизация заметки (общая для GET/:id, PATCH, DELETE):**
1. `findNoteById` без фильтра по userId/deletedAt — нужен сырой документ.
2. Если строки нет или `deletedAt !== null` → `Result.err('not_found', 'NOT_FOUND')` → HTTP 404.
3. Если `note.userId !== userId` → `Result.err('forbidden', 'FORBIDDEN')` → HTTP 403.
4. Иначе работаем с заметкой.

Различие 404/403 продиктовано требованием: фронт по прямой ссылке на чужой `id` должен видеть «нет доступа» (403), а на несуществующий — «нет такой заметки» (404).

**Создание заметки (`POST /notes`):**
1. Zod-валидация: `contentJson` (объект, любой Tiptap-документ), `contentText` (строка ≤ 1 МБ), опционально `title` (≤ 500), `groupId` (uuid|null), `tags` (массив строк, ≤ 20 шт, каждая ≤ 64 симв).
2. Генерация `id = crypto.randomUUID()`, `createdAt/updatedAt = now`, `deletedAt = null`, `isIndexedAt = null`.
3. `insertNote` (`returning()`).
4. Сервис возвращает `{ note, index: { kind: 'upsert', userId, noteId, contentText } }`.
5. Роут: фронту отдаёт только `note` (`201`), затем `triggerVectorIndex(c, index)` стреляет `c.executionCtx.waitUntil` для индексации в Vectorize в фоне.

**Список заметок (`GET /notes`):**
1. Zod-валидация query: `groupId?` (uuid), `tag?` — оба опциональны.
2. `listNotesByUser`: фильтр `userId = ? AND deletedAt IS NULL`, плюс опциональные `groupId = ?` и `EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)`.
3. Сортировка `updatedAt DESC` (свежие сверху). Пагинации нет (YAGNI).
4. Ответ `200 Note[]`.

**Получение одной заметки (`GET /notes/:id`):**
1. Zod-валидация param: `id` — UUID.
2. `authoriseNote` → 200/403/404.

**Обновление заметки (`PATCH /notes/:id`):**
1. Zod-валидация param и body. Body — любое подмножество `{ title, contentJson, contentText, groupId, tags }`, но не пустое (`refine`).
2. `authoriseNote`.
3. `updateNoteFields`: `set` собирается динамически из заданных полей, `updatedAt = now` ставится всегда.
4. Сервис возвращает `{ note, index: { kind: 'upsert', ... } }` (re-upsert использует тот же id вектора, обновляет embedding).
5. Роут: `200 Note` + `triggerVectorIndex(c, index)`. На PATCH всегда шлём upsert, даже если изменился только `title`/`tags`.

**Удаление заметки (`DELETE /notes/:id`):**
1. Zod-валидация param.
2. `authoriseNote`.
3. `softDeleteNote`: `set deletedAt = now, updatedAt = now`. Реальная строка остаётся в D1 (для будущего восстановления).
4. Сервис возвращает `{ index: { kind: 'delete', userId, noteId } }`.
5. Роут: `204 No Content` + `triggerVectorIndex(c, index)` — вектор удаляется из Vectorize.

**Список групп (`GET /groups`):**
1. `countGroupsByUser` — если групп нет, авто-сидирует дефолтные группы (`DEFAULT_GROUPS`), возвращает их вместе с `toIndex`-действиями для фоновой векторной индексации.
2. Если группы уже есть — `listGroupsByUser`, `toIndex: []`.
3. Роут: `200 Group[]` + `triggerGroupVectorIndex` для каждого действия из `toIndex`.

**Создание группы (`POST /groups`):**
1. Zod-валидация: `name` (1..100), опционально `description` (≤ 500), `icon` (≤ 50), `color` (hex-строка `#RRGGBB`).
2. `insertGroup` с дефолтами: `description: ''`, `icon: 'FileText'`, `color: '#64748b'`, `isDefault: false`.
3. Сервис возвращает `{ group, index: GroupIndexAction{kind:'upsert'} }`.
4. Роут: `201 Group` + `triggerGroupVectorIndex`.

**Обновление группы (`PATCH /groups/:id`):**
1. Zod-валидация param и body (любое подмножество `{ name, description, icon, color }`, не пустое).
2. `authoriseGroup` → 403/404.
3. `updateGroupFields` с `updatedAt = now`.
4. Роут: `200 Group` + `triggerGroupVectorIndex`.

**Удаление группы (`DELETE /groups/:id`):**
1. `authoriseGroup` → 403/404.
2. `clearGroupIdFromNotes(db, userId, id)` — обнуляет `groupId` у всех заметок этой группы (referential integrity внутри одного воркера).
3. `deleteGroupById`.
4. Роут: `204 No Content` + `triggerGroupVectorIndex(c, { kind: 'delete', ... })`.

**`x-user-id` (`requireUserId` middleware):**
1. Считывается из заголовка, который ставит gateway после JWT-проверки.
2. Пустой / отсутствует → `401 UNAUTHORIZED`.
3. Кладётся в Hono `Variables` как `userId`.

JWT здесь не валидируется (CLAUDE.md → правило 11).

## Зависимости

- **D1** (`env.DB`, общая база `notetaker`) → таблицы `notes`, `groups`.
- **Service Binding `AI`** (`env.AI: Fetcher` → `notetaker-ai`) — для фоновой индексации заметок и групп в Vectorize после успешного CRUD (Phase 5B, Phase 8). Вызовы идут через `c.executionCtx.waitUntil` без `await`.
- **Внешние пакеты:** `hono`, `@hono/zod-validator`, `zod`, `drizzle-orm`.

## Routes (через gateway, под `/notes/*` + `/groups/*` + JWT middleware)

**Заметки:**
- `POST /notes` — `{ title?, contentJson, contentText, groupId?, tags? }` → `201 Note`.
- `GET /notes` — `?groupId=<uuid>&tag=<string>` (оба опциональны) → `200 Note[]`, sort `updatedAt DESC`.
- `GET /notes/:id` — UUID → `200 Note` / `403 FORBIDDEN` / `404 NOT_FOUND`.
- `PATCH /notes/:id` — любое подмножество полей, ≥1 → `200 Note` / `400` / `403` / `404`.
- `DELETE /notes/:id` — soft-delete → `204` / `403` / `404`.

**Группы:**
- `GET /groups` → `200 Group[]` (авто-сидирует дефолты при первом запросе).
- `POST /groups` — `{ name, description?, icon?, color? }` → `201 Group`.
- `PATCH /groups/:id` — `{ name?, description?, icon?, color? }` (≥1 поле) → `200 Group` / `403` / `404`.
- `DELETE /groups/:id` → `204` / `403` / `404`.

## Internal endpoints / RPC
Те же пути, что выше — gateway проксирует «как есть». Дополнительно `GET /notes` и `GET /notes/:id` используются **ai-воркером** через SVC binding `NOTES` для: F4 develop-suggestions (`GET /notes`), RAG-контекста F5 discuss (`GET /notes/:id`), поиска/merge/suggest-group.

## Services

**Заметки:**
- `createNote(env, userId, input) → Result<NoteMutationResult>` — генерирует id, ставит `createdAt/updatedAt`, дефолтит `tags: []`, `groupId: null`, `title: ''`. Возвращает `{ note, index: 'upsert' }`.
- `listNotes(env, userId, filters) → Result<Note[]>` — обёртка над `listNotesByUser`.
- `getNote(env, userId, id) → Result<Note>` — через `authoriseNote`.
- `updateNote(env, userId, id, input) → Result<NoteMutationResult>` — `authoriseNote` → `updateNoteFields`. Возвращает `{ note, index: 'upsert' }`.
- `deleteNote(env, userId, id) → Result<DeleteMutationResult>` — `authoriseNote` → `softDeleteNote`. Возвращает `{ index: 'delete' }`.
- `authoriseNote(env, id, userId) → Result<Note>` — единый источник правды по 404/403 (приватная для модуля).

**Группы:**
- `listGroups(env, userId) → Result<ListGroupsResult>` — авто-сидирование при отсутствии групп. Возвращает `{ groups, toIndex: GroupIndexAction[] }`.
- `createGroup(env, userId, input) → Result<GroupMutationResult>` — `insertGroup` с дефолтами. Возвращает `{ group, index: 'upsert' }`.
- `updateGroup(env, userId, id, input) → Result<GroupMutationResult>` — `authoriseGroup` → `updateGroupFields`. Возвращает `{ group, index: 'upsert' }`.
- `deleteGroup(env, userId, id) → Result<{index}>` — `authoriseGroup` → `clearGroupIdFromNotes` → `deleteGroupById`. Возвращает `{ index: 'delete' }`.
- `authoriseGroup(env, id, userId) → Result<Group>` — 404/403 по аналогии с заметками (приватная).

`IndexAction = { kind: 'upsert' | 'delete', userId, noteId, ...payload }` — discriminated union для заметок.
`GroupIndexAction = { kind: 'upsert' | 'delete', userId, groupId, ...payload }` — discriminated union для групп.
Сервисы HTTP-agnostic: не принимают `ExecutionContext`, не зовут `env.AI.fetch` сами.

## Queries (db/)

**Заметки (`notes.queries.ts`):**
- `insertNote(db, note) → Note` — insert + `returning()`.
- `findNoteById(db, id) → Note | null` — без фильтра по userId/deletedAt; для авторизации в сервисе.
- `listNotesByUser(db, userId, filters) → Note[]` — `userId = ? AND deletedAt IS NULL`, опциональные `groupId = ?` и `EXISTS (json_each(tags) WHERE value = ?)`, sort `updatedAt DESC`.
- `updateNoteFields(db, id, patch: NotePatch) → Note` — динамический `set` только из заданных полей + всегда `updatedAt`.
- `softDeleteNote(db, id, deletedAt) → void` — `set deletedAt, updatedAt`.

**Группы (`groups.queries.ts`):**
- `countGroupsByUser(db, userId) → number` — для проверки наличия групп перед авто-сидированием.
- `listGroupsByUser(db, userId) → Group[]` — все группы пользователя.
- `insertGroup(db, group) → Group` — insert + `returning()`.
- `insertGroups(db, groups[]) → Group[]` — batch-insert для авто-сидирования дефолтов.
- `findGroupById(db, id) → Group | null` — для авторизации.
- `updateGroupFields(db, id, patch) → Group` — динамический `set`.
- `deleteGroupById(db, id) → void` — hard-delete (группа не восстанавливается).
- `clearGroupIdFromNotes(db, userId, groupId) → void` — `SET group_id = NULL` для заметок удалённой группы; гарантирует referential integrity внутри одного воркера.

## Ограничения

- **Нет публичного `routes` в `wrangler.jsonc`.** Internal-only (CLAUDE.md → правило 1).
- **Нет JWT-middleware.** Только `x-user-id` из gateway (CLAUDE.md → правило 11).
- **Нет AI/Vectorize биндингов** — только Service Binding `AI` → `notetaker-ai` (CLAUDE.md → правила 4, 5).
- **Нет FK между `notes.groupId` и `groups.id`.** D1 в одном воркере: при удалении группы `clearGroupIdFromNotes` обнуляет ссылку логически. Это надёжнее, чем FK с CASCADE в SQLite (нет нужды в `PRAGMA foreign_keys=ON`).
- **`contentJson` не парсится на бэке.** Принимается как объект, хранится в `text` колонке через Drizzle `mode: 'json'`. Извлечение plain-текста — обязанность фронта (`contentText`).
- **Лимиты:** `title ≤ 500`, `contentText ≤ 1 МБ`, `tags ≤ 20 элементов`, `tag ≤ 64 симв`, `name ≤ 100`, `description ≤ 500`, `color` — hex `#RRGGBB`.
- **Soft-delete заметок необратим со стороны API.** Строка остаётся в БД для возможного восстановления через SQL.
- **Hard-delete групп.** Группа удаляется навсегда; заметки остаются (groupId обнуляется).
- **Авто-сидирование дефолтных групп** при первом `GET /groups`. `DEFAULT_GROUPS` — константа в `src/config/default-groups.ts`. Сидирование идемпотентно благодаря `countGroupsByUser`: повторный вызов при уже созданных группах не дублирует их.
- **Нет пагинации.** Ни для заметок, ни для групп. YAGNI для тестового задания.
- **`isIndexedAt` остаётся `null`.** Обновление флага потребовало бы обратной петли `ai → notes`; YAGNI.
- **Без retry-обёртки на `waitUntil`.** Если ai-воркер упал на фоновой индексации — CRUD уже успешен, ошибка уйдёт в `wrangler tail`.
