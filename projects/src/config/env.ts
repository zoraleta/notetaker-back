// Internal-воркер `projects`: JWT-проверка живёт в gateway (CLAUDE.md → правило 11),
// поэтому здесь нет JWT_SECRET. userId приходит заголовком x-user-id из gateway.
//
// `NOTES` — Service Binding на `notetaker-notes`. Используется для batch-обновления
// projectId в заметках при from-pack и при удалении проекта.
export interface Env {
	DB: D1Database
	NOTES: Fetcher
}

export type Variables = {
	userId: string
}

export type AppBindings = {
	Bindings: Env
	Variables: Variables
}
