import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppBindings } from './config/env'
import { corsMiddleware } from './middleware/cors.middleware'
import { jwtMiddleware } from './middleware/jwt.middleware'
import { aiRoutes } from './routes/ai.routes'
import { authRoutes } from './routes/auth.routes'
import { linksRoutes } from './routes/links.routes'
import { notesRoutes } from './routes/notes.routes'
import { projectsRoutes } from './routes/projects.routes'
import { settingsRoutes } from './routes/settings.routes'

// Public воркер `notetaker-api-gateway`. Единственная точка входа для фронта:
// CORS + JWT + проксирование во внутренние воркеры через Service Bindings.
// Полный список правил — notetaker-back/CLAUDE.md.

const app = new Hono<AppBindings>()

// CORS — первым: должен отвечать на preflight (OPTIONS) до остальных middleware.
app.use('*', corsMiddleware)

// Анонимные роуты (без JWT) — auth выдаёт токен.
app.route('/auth', authRoutes)

// JWT-middleware вешается ровно на защищённые префиксы.
// Phase 7 добавит /projects/*.
app.use('/notes/*', jwtMiddleware)
app.use('/ai/*', jwtMiddleware)
app.use('/projects/*', jwtMiddleware)
app.use('/links/*', jwtMiddleware)
app.use('/settings/*', jwtMiddleware)

// Защищённые роуты — после JWT-middleware.
app.route('/notes', notesRoutes)
app.route('/ai', aiRoutes)
app.route('/settings', settingsRoutes)
app.route('/links', linksRoutes)
app.route('/projects', projectsRoutes)

// Централизованный обработчик непредвиденных ошибок (CLAUDE.md → правило 5).
// Ожидаемые ошибки приходят как Result<T> из internal-воркеров и проксируются
// «как есть» (gateway не разбирает их тело — это работа auth/notes/ai/...).
app.onError((error, c) => {
	if (error instanceof HTTPException) {
		return error.getResponse()
	}
	console.error('api-gateway worker unhandled error', error)
	return c.json({ error: 'Внутренняя ошибка сервиса', code: 'EXTERNAL' }, 500)
})

app.notFound((c) => c.json({ error: 'Маршрут не найден', code: 'NOT_FOUND' }, 404))

export default app
