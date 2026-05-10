import { cors } from 'hono/cors'

// CORS живёт только в gateway (CLAUDE.md → правило 11): internal-воркеры
// без публичного URL и не должны его настраивать.
//
// Список origin-ов — статический whitelist. На старте пускаем dev-фронт (Vite),
// production-домен Pages добавится после первого деплоя в Phase 9.
const ALLOWED_ORIGINS: readonly string[] = ['http://localhost:5173']

export const corsMiddleware = cors({
	origin: (origin) => (ALLOWED_ORIGINS.includes(origin) ? origin : null),
	allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
	allowHeaders: ['Content-Type', 'Authorization'],
	credentials: false,
	maxAge: 600,
})
