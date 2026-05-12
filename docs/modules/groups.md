# groups

CRUD групп пользователя. Группа — именованный контейнер для заметок с иконкой, цветом и описанием. Хранится в таблице `groups` внутри воркера `notetaker-notes`.

## Воркер
`notetaker-notes` — groups физически живут здесь, в той же D1-базе и том же воркере, что и заметки. Отдельного воркера нет (CLAUDE.md → YAGNI).

## Логика работы

**Авторизация (общая для PATCH, DELETE):**
1. `findGroupById(db, id)` — без фильтра по userId.
2. Если строки нет → `NOT_FOUND` → HTTP 404.
3. Если `group.userId !== userId` → `FORBIDDEN` → HTTP 403.

**Авто-сидирование дефолтных групп:**
При первом `GET /groups` (до момента, когда у пользователя 0 групп) сервис вставляет группы из `DEFAULT_GROUPS` (`src/config/default-groups.ts`). Все сидированные группы получают `isDefault: true`. Идемпотентно: повторный вызов при уже существующих группах просто возвращает их.

Авто-сидирование запускает фоновую векторную индексацию: `GET /groups` возвращает `{ groups, toIndex: GroupIndexAction[] }`, роут стреляет `triggerGroupVectorIndex` для каждого элемента `toIndex`.

**Referential integrity с заметками:**
При удалении группы `clearGroupIdFromNotes(db, userId, groupId)` обнуляет `group_id` у всех живых заметок этой группы (`deleted_at IS NULL`). Транзакция внутри одного воркера — надёжнее, чем FK с CASCADE.

**Векторная индексация групп:**
После каждого успешного create/update/delete роут стреляет `c.executionCtx.waitUntil(env.AI.fetch('/internal/vectors/group-upsert' | '/internal/vectors/group-delete'))`. В ai-воркере имя+описание группы эмбеддится через `@cf/baai/bge-m3` и хранится в Vectorize с id `group:<uuid>`. Используется в `POST /ai/suggest-group` для подбора подходящей группы по тексту заметки.

## Зависимости
- **D1** (`env.DB`) → таблицы `groups`, `notes` (для `clearGroupIdFromNotes`).
- **Service Binding `AI`** (`env.AI: Fetcher`) → `/internal/vectors/group-upsert`, `/internal/vectors/group-delete`.

## Routes (публичные через gateway, под `/groups/*` + JWT middleware)
- `GET /groups` → `200 Group[]`. Авто-сидирует дефолтные при первом запросе.
- `POST /groups` — body `{ name: string(1..100), description?: string(≤500), icon?: string(≤50), color?: string(#RRGGBB) }` → `201 Group`.
- `PATCH /groups/:id` — body: подмножество `{ name, description, icon, color }`, ≥1 поле → `200 Group` / `403` / `404`.
- `DELETE /groups/:id` → `204` / `403` / `404`.

## Internal endpoints / RPC
Те же пути, что выше — gateway проксирует без изменения URL. Нет отдельных internal-эндпоинтов для других воркеров.

## Services

Все в `src/services/groups.service.ts`:

- `listGroups(env, userId) → Result<ListGroupsResult>` — `countGroupsByUser` → если 0, `insertGroups(DEFAULT_GROUPS)` → формирует `toIndex` для фоновой индексации. Иначе `listGroupsByUser` с `toIndex: []`.
- `createGroup(env, userId, input) → Result<GroupMutationResult>` — `insertGroup` с дефолтами `description:''`, `icon:'FileText'`, `color:'#64748b'`, `isDefault:false`. Возвращает `{ group, index: GroupIndexAction{kind:'upsert'} }`.
- `updateGroup(env, userId, id, input) → Result<GroupMutationResult>` — `authoriseGroup` → `updateGroupFields(updatedAt=now)`. Возвращает `{ group, index: 'upsert' }`.
- `deleteGroup(env, userId, id) → Result<{index}>` — `authoriseGroup` → `clearGroupIdFromNotes` → `deleteGroupById`. Возвращает `{ index: 'delete' }`.
- `authoriseGroup(env, id, userId) → Result<Group>` — приватная; 404/403.

`GroupIndexAction`:
```ts
| { kind: 'upsert'; userId: string; groupId: string; name: string; description: string }
| { kind: 'delete'; userId: string; groupId: string }
```

## Queries (db/)

Все в `src/db/groups.queries.ts`:

- `countGroupsByUser(db, userId) → number` — `COUNT(*)` по userId.
- `listGroupsByUser(db, userId) → Group[]` — все группы пользователя.
- `findGroupById(db, id) → Group | null` — для авторизации.
- `insertGroup(db, group) → Group` — insert + `returning()`.
- `insertGroups(db, groups[]) → Group[]` — batch-insert для авто-сидирования.
- `updateGroupFields(db, id, patch) → Group` — динамический `set`, всегда `updatedAt`.
- `deleteGroupById(db, id) → void` — hard-delete.
- `clearGroupIdFromNotes(db, userId, groupId) → void` — `SET group_id = NULL WHERE user_id = ? AND group_id = ? AND deleted_at IS NULL`.

## Ограничения

- **Hard-delete групп.** Удалённая группа не восстанавливается. Заметки не удаляются — только обнуляется `groupId`.
- **`isDefault`** — флаг дефолтной группы. Только читается фронтом (для UX). API не позволяет выставить его через POST/PATCH (`isDefault: false` всегда при создании через API).
- **Нет ограничения на количество групп** одного пользователя (YAGNI).
- **Нет публичного URL** — только через Service Binding `NOTES` из gateway (CLAUDE.md → правило 1).
- **Нет JWT-middleware** — только `x-user-id` от gateway (CLAUDE.md → правило 11).
