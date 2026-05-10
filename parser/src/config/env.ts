// Internal-воркер `parser`: JWT-проверка живёт в gateway (CLAUDE.md → правило 11),
// поэтому здесь нет JWT_SECRET. userId приходит заголовком x-user-id из gateway.
//
// Воркер не работает с D1 (extraction = pure transform URL → текст), не имеет
// `env.AI` / `env.VECTORIZE` (CLAUDE.md → правила 4, 5: AI/Vectorize только в ai).
export interface Env {}

export type Variables = {
	userId: string
}

export type AppBindings = {
	Bindings: Env
	Variables: Variables
}
