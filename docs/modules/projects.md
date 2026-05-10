# projects

CRUD проектов; упаковка диалога AI в проект; управление привязкой заметок к проекту.

## Воркер
`notetaker-projects` — `projects/` в репозитории.

## Логика работы

Проект — контейнер для группировки заметок с метаданными (цель, этапы, открытые вопросы). Заметки не переносятся физически — связь хранится полем `project_id` в таблице `notes` (воркер `notes`).

При создании через `from-pack`: проект создаётся в `projects`, затем через Service Binding к `notetaker-notes` вызывается `/internal/notes/link-project` — устанавливает `project_id` для указанных заметок.

При удалении проекта: сначала через Service Binding к `notetaker-notes` вызывается `/internal/notes/unlink-project` — обнуляет `project_id` у всех заметок проекта, затем проект удаляется из `projects`.

Авторизация: для каждой операции чтения/изменения/удаления запрашивается проект из БД, сравнивается `userId` — различаются 404 (нет) и 403 (чужой).

## Зависимости

- **D1** — таблица `projects`.
- **notetaker-notes** (Service Binding `NOTES`) — batch-обновление `project_id` в заметках.

## Routes (публичные через gateway)

- `POST /projects` — создать проект (`{ name, description? }`), возвращает `Project` 201.
- `GET /projects` — список проектов текущего пользователя.
- `GET /projects/:id` — один проект; 404/403 если нет/не свой.
- `PATCH /projects/:id` — обновить поля (`{ name?, description?, goal?, stages?, openQuestions? }`); хотя бы одно поле обязательно.
- `DELETE /projects/:id` — удалить; обнуляет `projectId` в заметках; 204.
- `POST /projects/from-pack` — создать из pack-данных AI (`{ name, description?, pack: { goal?, stages?, openQuestions? }, sourceNoteIds: string[] }`); 201.

## Internal endpoints / RPC

Нет — projects сам вызывает notes через Service Binding, но не экспонирует internal-эндпоинты.

## Services

- `createProject(env, userId, input)` — вставляет запись в `projects`.
- `fromPackProject(env, userId, input)` — вставляет проект + вызывает `callNotesLinkProject`.
- `listProjects(env, userId)` — все проекты пользователя, desc по `updatedAt`.
- `getProject(env, userId, id)` — авторизация + возврат проекта.
- `updateProject(env, userId, id, input)` — авторизация + обновление полей.
- `deleteProject(env, userId, id)` — авторизация + `callNotesUnlinkProject` + удаление.

## Queries (db/)

- `insertProject(db, project)` — INSERT + RETURNING.
- `findProjectById(db, id)` — без фильтра по userId (авторизация в сервисе).
- `listProjectsByUser(db, userId)` — ORDER BY updated_at DESC.
- `updateProjectFields(db, id, patch)` — UPDATE только переданных полей.
- `deleteProjectById(db, id)` — DELETE.

## Ограничения

- Заметки при удалении проекта не удаляются — только обнуляется `project_id`.
- `sourceNoteIds` в `from-pack` не проверяется на принадлежность пользователю (фильтр по userId в notes-запросе защищает от записи чужих заметок).
- Нет пагинации списка проектов — предполагается разумное количество проектов на пользователя.
