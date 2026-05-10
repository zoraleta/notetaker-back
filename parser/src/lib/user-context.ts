import { createMiddleware } from 'hono/factory'
import type { AppBindings } from '../config/env'

// gateway перед каждым проксированием в parser ставит x-user-id из JWT.
// Для internal-воркера это единственный источник правды о пользователе —
// JWT мы не парсим (CLAUDE.md → правило 11). Если заголовка нет, значит
// gateway вызвал нас в обход своей JWT-цепочки — отвечаем 401.
//
// Сам parser userId не использует семантически (extraction = stateless),
// но проверка обязательна как страховка от конфигурационного бага в gateway.
export const requireUserId = createMiddleware<AppBindings>(async (c, next) => {
	const userId = c.req.header('x-user-id')?.trim()
	if (!userId) {
		return c.json({ error: 'Требуется авторизация', code: 'UNAUTHORIZED' as const }, 401)
	}
	c.set('userId', userId)
	await next()
})
