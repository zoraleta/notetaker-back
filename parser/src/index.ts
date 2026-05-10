import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppBindings } from './config/env'
import { parserRoutes } from './routes/parser.routes'

// Internal-воркер `notetaker-parser` (Phase 6, F1 extraction). Доступен только
// через Service Binding `PARSER` от `notetaker-api-gateway` — публичных routes
// нет. CORS, JWT и аутентификация остаются в gateway (CLAUDE.md → правило 11).
//
// userId доходит сюда заголовком x-user-id; middleware requireUserId
// валидирует его наличие и кладёт в Variables. Сам extraction stateless —
// userId нужен только как «авторизован ли вызывающий вообще».

const app = new Hono<AppBindings>()

app.route('/', parserRoutes)

app.onError((error, c) => {
	if (error instanceof HTTPException) {
		return error.getResponse()
	}
	console.error('parser worker unhandled error', error)
	return c.json({ error: 'Внутренняя ошибка сервиса', code: 'EXTERNAL' }, 500)
})

app.notFound((c) => c.json({ error: 'Маршрут не найден', code: 'NOT_FOUND' }, 404))

export default app
