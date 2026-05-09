// Internal-воркер `notes`: JWT-проверка живёт в gateway (CLAUDE.md → правило 11),
// поэтому здесь нет JWT_SECRET. userId приходит заголовком x-user-id из gateway.
export interface Env {
	DB: D1Database
}

export type Variables = {
	userId: string
}

export type AppBindings = {
	Bindings: Env
	Variables: Variables
}
