import type { Context } from 'hono'
import type { zValidator } from '@hono/zod-validator'
import type { AppBindings } from '../config/env'
import type { Result, ResultErrorCode } from './result'

// HTTP-хелперы для роут-слоя. Идентичны `notes/src/lib/http.ts` —
// CLAUDE.md разрешает копирование общих хелперов между воркерами,
// пока не появится 5+ реальных расхождений (тогда выделим в общий пакет).

// Маппинг кода ошибки в HTTP-статус. Один источник правды.
export const STATUS_BY_CODE: Record<ResultErrorCode, 400 | 401 | 403 | 404 | 502> = {
	VALIDATION: 400,
	UNAUTHORIZED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	EXTERNAL: 502,
}

// Хук для @hono/zod-validator: единый формат { error, code: 'VALIDATION' }
// (выровнен с доменными ошибками). Сообщение из первого issue схемы.
export const validationHook: Parameters<typeof zValidator>[2] = (result, c) => {
	if (!result.success) {
		return c.json(
			{ error: result.error.issues[0]?.message ?? 'Невалидные данные', code: 'VALIDATION' as const },
			400,
		)
	}
}

// Универсальный сериализатор Result<T> в Hono Response для 200/201.
export function toResponse<T>(c: Context<AppBindings>, result: Result<T>, successStatus: 200 | 201): Response {
	if (result.ok) {
		return c.json(result.data, successStatus)
	}
	return errResponse(c, result)
}

// Отдельный helper для error-веток без преобразования успешного Result.data.
export function errResponse(
	c: Context<AppBindings>,
	result: Extract<Result<unknown>, { ok: false }>,
): Response {
	return c.json({ error: result.error, code: result.code }, STATUS_BY_CODE[result.code])
}
