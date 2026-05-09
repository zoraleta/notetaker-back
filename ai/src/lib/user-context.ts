import { createMiddleware } from 'hono/factory'
import type { AppBindings } from '../config/env'

// gateway/notes перед каждым вызовом ai ставят x-user-id (gateway — из JWT,
// notes — пробрасывают свой). Для internal-воркера это единственный источник
// правды о пользователе — JWT мы не парсим (CLAUDE.md → правило 11). Если
// заголовка нет, значит вызывающая сторона нарушила контракт — отвечаем 401.
export const requireUserId = createMiddleware<AppBindings>(async (c, next) => {
	const userId = c.req.header('x-user-id')?.trim()
	if (!userId) {
		return c.json({ error: 'Требуется авторизация', code: 'UNAUTHORIZED' as const }, 401)
	}
	c.set('userId', userId)
	await next()
})
