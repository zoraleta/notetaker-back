// Internal-воркер `auth`: JWT-проверка живёт в gateway, поэтому здесь
// JWT_SECRET нужен только для подписи токена при register/login.
// (См. notetaker-back/CLAUDE.md → «Типы Env и Variables».)
export interface Env {
	DB: D1Database
	JWT_SECRET: string
}
