import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Env } from './config/env'
import { authRoutes } from './routes/auth'

// Internal-воркер `notetaker-auth`. Доступен только через Service Binding
// от `notetaker-api-gateway` — публичных routes у этого воркера нет.
// Поэтому здесь нет CORS и JWT-middleware: и то, и другое живёт в gateway.

const app = new Hono<{ Bindings: Env }>()

app.route('/', authRoutes)

// Централизованный обработчик непредвиденных ошибок (см. CLAUDE.md → правило 5).
// Ожидаемые ошибки приходят как Result<T> из сервисов и не попадают сюда.
app.onError((error, c) => {
	if (error instanceof HTTPException) {
		return error.getResponse()
	}
	console.error('auth worker unhandled error', error)
	return c.json({ error: 'Внутренняя ошибка сервиса', code: 'EXTERNAL' }, 500)
})

app.notFound((c) => c.json({ error: 'Маршрут не найден', code: 'NOT_FOUND' }, 404))

export default app
