import type { Context } from 'hono'
import type { zValidator } from '@hono/zod-validator'
import type { AppBindings } from '../config/env'
import type { Result, ResultErrorCode } from './result'

// HTTP-хелперы для роут-слоя. Идентичны `ai/src/lib/http.ts` —
// CLAUDE.md разрешает копирование общих хелперов между воркерами,
// пока не появится 5+ реальных расхождений (тогда выделим в общий пакет).
// Раньше блок жил inline в `routes/notes.ts`; вынесен в lib/, чтобы
// при появлении новых роут-файлов в notes-воркере не плодились копии.

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

// Универсальный сериализатор Result<T> в Hono Response. Для 204 (DELETE)
// сервис возвращает Result<{...}> — роут сам отдаёт `new Response(null, 204)`,
// toResponse поддерживает только 200/201 (формат с телом).
export function toResponse<T>(c: Context<AppBindings>, result: Result<T>, successStatus: 200 | 201): Response {
	if (result.ok) {
		return c.json(result.data, successStatus)
	}
	return errResponse(c, result)
}

// Отдельный helper для error-веток, которыми надо отвечать без преобразования
// успешного Result.data (например, в POST/PATCH сначала достаём data.note,
// потом стреляем waitUntil — toResponse не подходит).
export function errResponse(
	c: Context<AppBindings>,
	result: Extract<Result<unknown>, { ok: false }>,
): Response {
	return c.json({ error: result.error, code: result.code }, STATUS_BY_CODE[result.code])
}
