import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppBindings } from './config/env'
import { projectsRoutes } from './routes/projects'

// Internal-воркер `notetaker-projects` (F3 backend). Доступен только через
// Service Binding `PROJECTS` от `notetaker-api-gateway` — публичных routes нет.
// CORS, JWT и аутентификация остаются в gateway (CLAUDE.md → правило 11).
//
// userId доходит сюда заголовком x-user-id; middleware requireUserId
// валидирует его наличие и кладёт в Variables.

const app = new Hono<AppBindings>()

app.route('/', projectsRoutes)

app.onError((error, c) => {
	if (error instanceof HTTPException) {
		return error.getResponse()
	}
	console.error('projects worker unhandled error', error)
	return c.json({ error: 'Внутренняя ошибка сервиса', code: 'EXTERNAL' }, 500)
})

app.notFound((c) => c.json({ error: 'Маршрут не найден', code: 'NOT_FOUND' }, 404))

export default app
