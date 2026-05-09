// Internal-воркер `notes`: JWT-проверка живёт в gateway (CLAUDE.md → правило 11),
// поэтому здесь нет JWT_SECRET. userId приходит заголовком x-user-id из gateway.
//
// `AI` — Service Binding на `notetaker-ai`. Используется для фоновой
// индексации заметки в Vectorize после CRUD: роут стреляет
// `c.executionCtx.waitUntil(env.AI.fetch('https://internal/internal/vectors/...', ...))`
// (CLAUDE.md → правило 9 «AI-вызовы — только из ai. Любой другой воркер
// зовёт ai-воркер через Service Binding»).
export interface Env {
	DB: D1Database
	AI: Fetcher
}

export type Variables = {
	userId: string
}

export type AppBindings = {
	Bindings: Env
	Variables: Variables
}
