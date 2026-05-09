import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppBindings } from './config/env'
import { searchRoutes } from './routes/search.routes'
import { smokeRoutes } from './routes/smoke.routes'
import { vectorsRoutes } from './routes/vectors.routes'

// Internal-воркер `notetaker-ai` (Phase 5). Доступен только через
// Service Bindings `AI` (от api-gateway и notes) — публичных routes нет.
// CORS, JWT и аутентификация остаются в gateway (CLAUDE.md → правило 11).
//
// /__smoke/* — временные DoD-роуты Phase 5A, удаляются в 5B-6 после
// финальной проверки. Бизнес-роуты подключаются по этапам 5B-5G.

const app = new Hono<AppBindings>()

app.get('/', (c) => c.json({ status: 'ok', worker: 'notetaker-ai' }, 200))

app.route('/', smokeRoutes)
app.route('/', vectorsRoutes)
app.route('/', searchRoutes)

app.onError((error, c) => {
	if (error instanceof HTTPException) {
		return error.getResponse()
	}
	console.error('ai worker unhandled error', error)
	return c.json({ error: 'Внутренняя ошибка сервиса', code: 'EXTERNAL' }, 500)
})

app.notFound((c) => c.json({ error: 'Маршрут не найден', code: 'NOT_FOUND' }, 404))

export default app
