import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { Env } from '../config/env'
import { loginUser, registerUser, type AuthSuccess } from '../services/auth.service'
import type { Result, ResultErrorCode } from '../lib/result'

const credentialsSchema = z.object({
	email: z.email('Некорректный email'),
	password: z.string().min(8, 'Пароль должен содержать минимум 8 символов'),
})

// Маппинг кода ошибки в HTTP-статус. Один источник правды — расширяется
// добавлением новой ветки в ResultErrorCode (TS заставит обновить таблицу).
const STATUS_BY_CODE: Record<ResultErrorCode, 400 | 401 | 403 | 404 | 502> = {
	VALIDATION: 400,
	UNAUTHORIZED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	EXTERNAL: 502,
}

export const authRoutes = new Hono<{ Bindings: Env }>()
	.post('/register', zValidator('json', credentialsSchema), async (c) => {
		const result = await registerUser(c.env, c.req.valid('json'))
		return toResponse(c, result, 201)
	})
	.post('/login', zValidator('json', credentialsSchema), async (c) => {
		const result = await loginUser(c.env, c.req.valid('json'))
		return toResponse(c, result, 200)
	})

function toResponse(
	c: Context<{ Bindings: Env }>,
	result: Result<AuthSuccess>,
	successStatus: 200 | 201,
) {
	if (result.ok) {
		return c.json(result.data, successStatus)
	}
	return c.json({ error: result.error, code: result.code }, STATUS_BY_CODE[result.code])
}
