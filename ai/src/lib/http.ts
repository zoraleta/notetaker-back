import type { Context } from 'hono'
import type { zValidator } from '@hono/zod-validator'
import type { AppBindings } from '../config/env'
import type { Result, ResultErrorCode } from './result'

// HTTP-хелперы, общие для всех роутов ai-воркера. Аналог inline-блока
// в notes/src/routes/notes.ts — вынесен в lib, потому что у ai будет
// 5+ роут-файлов (vectors, search, settings, summarize, classify,
// develop, discuss/pack), и копирование одного и того же STATUS_BY_CODE
// в каждом приведёт к рассинхрону формата ошибок.

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

// Универсальный сериализатор Result<T> в Hono Response. Для 204
// (DELETE-операции) сервис возвращает Result<void>; роут сам отдаёт
// `new Response(null, { status: 204 })` — toResponse поддерживает только
// 200/201 (формат с телом).
export function toResponse<T>(c: Context<AppBindings>, result: Result<T>, successStatus: 200 | 201): Response {
	if (result.ok) {
		return c.json(result.data, successStatus)
	}
	return c.json({ error: result.error, code: result.code }, STATUS_BY_CODE[result.code])
}
