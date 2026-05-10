import type { Context } from 'hono'
import type { zValidator } from '@hono/zod-validator'
import type { AppBindings } from '../config/env'
import type { Result, ResultErrorCode } from './result'

export const STATUS_BY_CODE: Record<ResultErrorCode, 400 | 401 | 403 | 404 | 502> = {
	VALIDATION: 400,
	UNAUTHORIZED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	EXTERNAL: 502,
}

export const validationHook: Parameters<typeof zValidator>[2] = (result, c) => {
	if (!result.success) {
		return c.json(
			{ error: result.error.issues[0]?.message ?? 'Невалидные данные', code: 'VALIDATION' as const },
			400,
		)
	}
}

export function toResponse<T>(c: Context<AppBindings>, result: Result<T>, successStatus: 200 | 201): Response {
	if (result.ok) {
		return c.json(result.data, successStatus)
	}
	return errResponse(c, result)
}

export function errResponse(
	c: Context<AppBindings>,
	result: Extract<Result<unknown>, { ok: false }>,
): Response {
	return c.json({ error: result.error, code: result.code }, STATUS_BY_CODE[result.code])
}
