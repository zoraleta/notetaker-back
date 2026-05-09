import { createMiddleware } from 'hono/factory'
import jwt from '@tsndr/cloudflare-worker-jwt'
import type { AppBindings } from '../config/env'

// Единственное место в системе, где валидируется JWT (CLAUDE.md → правило 11).
// Внутренние воркеры доверяют userId, который gateway пробрасывает заголовком
// x-user-id, и сами JWT не парсят.
//
// Формат заголовка: `Authorization: Bearer <token>`.
// Payload подписывает auth-воркер: { userId, email, iat, exp }.

interface JwtPayloadShape {
	userId: string
	email: string
}

export const jwtMiddleware = createMiddleware<AppBindings>(async (c, next) => {
	const token = extractBearerToken(c.req.header('Authorization'))
	if (!token) {
		return c.json({ error: 'Требуется авторизация', code: 'UNAUTHORIZED' }, 401)
	}

	// verify проверяет подпись и `exp`. На невалидной подписи / истёкшем токене
	// без `throwError: true` возвращает undefined, но на синтаксически кривых
	// токенах (нет трёх base64-сегментов и т.п.) всё равно бросает — поэтому
	// нужен try/catch, иначе мусорный Bearer уходит в 500.
	let verified: Awaited<ReturnType<typeof jwt.verify<JwtPayloadShape>>> = undefined
	try {
		verified = await jwt.verify<JwtPayloadShape>(token, c.env.JWT_SECRET, { algorithm: 'HS256' })
	} catch {
		verified = undefined
	}
	const payload = verified?.payload
	if (!payload?.userId || !payload.email) {
		return c.json({ error: 'Невалидный или истёкший токен', code: 'UNAUTHORIZED' }, 401)
	}

	c.set('user', { id: payload.userId, email: payload.email })
	await next()
})

function extractBearerToken(header: string | undefined): string | null {
	if (!header) return null
	const [scheme, token] = header.split(' ')
	if (scheme !== 'Bearer' || !token) return null
	return token.trim() || null
}
