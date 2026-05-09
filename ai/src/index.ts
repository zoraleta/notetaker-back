import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppBindings } from './config/env'
import { smokeRoutes } from './routes/smoke.routes'

// Internal-воркер `notetaker-ai` (Phase 5). Доступен только через
// Service Bindings `AI` (от api-gateway и notes) — публичных routes нет.
// CORS, JWT и аутентификация остаются в gateway (CLAUDE.md → правило 11).
//
// Этап 5A — skeleton: healthcheck + временные /__smoke/* для проверки
// биндингов и гибрида settings. Smoke-роуты удаляются в 5B/5C при
// появлении настоящих vector- и settings-эндпоинтов.

const app = new Hono<AppBindings>()

app.get('/', (c) => c.json({ status: 'ok', worker: 'notetaker-ai' }, 200))

app.route('/', smokeRoutes)

app.onError((error, c) => {
	if (error instanceof HTTPException) {
		return error.getResponse()
	}
	console.error('ai worker unhandled error', error)
	return c.json({ error: 'Внутренняя ошибка сервиса', code: 'EXTERNAL' }, 500)
})

app.notFound((c) => c.json({ error: 'Маршрут не найден', code: 'NOT_FOUND' }, 404))

export default app
