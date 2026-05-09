// Internal-воркер `ai`: единственный с биндингами Workers AI (`env.AI`) и
// Vectorize (`env.VECTORIZE`). JWT-проверка — в gateway, userId приходит
// заголовком x-user-id (CLAUDE.md → правило 11).
//
// `NOTES` — Service Binding к notetaker-notes; добавится в Phase 5F
// (для F4 develop-suggestions и F5 discuss RAG нужен content заметок).
export interface Env {
	DB: D1Database
	AI: Ai
	// `Vectorize` (новый класс с queryById/deleteByIds/getByIds), не `VectorizeIndex` (beta).
	VECTORIZE: Vectorize
}

export type Variables = {
	userId: string
}

export type AppBindings = {
	Bindings: Env
	Variables: Variables
}
