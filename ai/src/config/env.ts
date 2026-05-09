// Internal-воркер `ai`: единственный с биндингами Workers AI (`env.AI`) и
// Vectorize (`env.VECTORIZE`). JWT-проверка — в gateway, userId приходит
// заголовком x-user-id (CLAUDE.md → правило 11).
//
// `NOTES` — Service Binding к notetaker-notes (Phase 5F): ai зовёт `GET /notes`
// для F4 develop-suggestions; в Phase 5G — для RAG-контекста discuss.
export interface Env {
	DB: D1Database
	AI: Ai
	// `Vectorize` (новый класс с queryById/deleteByIds/getByIds), не `VectorizeIndex` (beta).
	VECTORIZE: Vectorize
	NOTES: Fetcher
}

export type Variables = {
	userId: string
}

export type AppBindings = {
	Bindings: Env
	Variables: Variables
}
