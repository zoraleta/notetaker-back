import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { AppBindings } from '../config/env'
import { requireUserId } from '../lib/user-context'
import {
	createNote,
	deleteNote,
	getNote,
	listNotes,
	updateNote,
} from '../services/notes.service'
import type { Result, ResultErrorCode } from '../lib/result'

// Лимиты длины полей. Cloudflare Workers держит тело запроса до 100 МБ,
// но прикладной разумный потолок куда меньше — иначе одна заметка может
// съесть лимиты Workers AI/Vectorize по токенам/dimensions при индексации.
const MAX_TITLE = 500
const MAX_TEXT = 1_000_000 // ~1 МБ — заведомо больше любой реалистичной заметки.
const MAX_TAG_LENGTH = 64
const MAX_TAGS = 20

const tagsSchema = z.array(z.string().min(1).max(MAX_TAG_LENGTH)).max(MAX_TAGS)

// Tiptap-документ — произвольный JSON-объект. На бэке не парсим (это работа
// фронта при рендере), но валидируем, что это объект, чтобы не записать
// в БД примитив или массив.
const contentJsonSchema = z.looseObject({})

const createSchema = z.object({
	title: z.string().max(MAX_TITLE).optional(),
	contentJson: contentJsonSchema,
	contentText: z.string().max(MAX_TEXT),
	projectId: z.string().min(1).nullable().optional(),
	tags: tagsSchema.optional(),
})

// PATCH: каждое поле опционально, но хотя бы одно должно прийти —
// иначе запрос бессмыслен и проще вернуть 400, чем тихо обновлять updatedAt.
const updateSchema = z
	.object({
		title: z.string().max(MAX_TITLE).optional(),
		contentJson: contentJsonSchema.optional(),
		contentText: z.string().max(MAX_TEXT).optional(),
		projectId: z.string().min(1).nullable().optional(),
		tags: tagsSchema.optional(),
	})
	.refine((data) => Object.values(data).some((value) => value !== undefined), {
		message: 'Нужно передать хотя бы одно поле для обновления',
	})

const listQuerySchema = z.object({
	projectId: z.string().min(1).optional(),
	tag: z.string().min(1).max(MAX_TAG_LENGTH).optional(),
})

const idParamSchema = z.object({ id: z.uuid() })

// Маппинг кода ошибки в HTTP-статус. Один источник правды.
const STATUS_BY_CODE: Record<ResultErrorCode, 400 | 401 | 403 | 404 | 502> = {
	VALIDATION: 400,
	UNAUTHORIZED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	EXTERNAL: 502,
}

// Хук-форматтер @hono/zod-validator: единый формат { error, code: 'VALIDATION' }
// (выровнен с доменными ошибками). Сообщение из первого issue схемы.
const validationHook = ((result, c) => {
	if (!result.success) {
		return c.json(
			{ error: result.error.issues[0]?.message ?? 'Невалидные данные', code: 'VALIDATION' as const },
			400,
		)
	}
}) satisfies Parameters<typeof zValidator>[2]

export const notesRoutes = new Hono<AppBindings>()
	.use('*', requireUserId)
	.post('/notes', zValidator('json', createSchema, validationHook), async (c) => {
		const result = await createNote(c.env, c.get('userId'), c.req.valid('json'))
		return toResponse(c, result, 201)
	})
	.get('/notes', zValidator('query', listQuerySchema, validationHook), async (c) => {
		const result = await listNotes(c.env, c.get('userId'), c.req.valid('query'))
		return toResponse(c, result, 200)
	})
	.get('/notes/:id', zValidator('param', idParamSchema, validationHook), async (c) => {
		const { id } = c.req.valid('param')
		const result = await getNote(c.env, c.get('userId'), id)
		return toResponse(c, result, 200)
	})
	.patch(
		'/notes/:id',
		zValidator('param', idParamSchema, validationHook),
		zValidator('json', updateSchema, validationHook),
		async (c) => {
			const { id } = c.req.valid('param')
			const result = await updateNote(c.env, c.get('userId'), id, c.req.valid('json'))
			return toResponse(c, result, 200)
		},
	)
	.delete('/notes/:id', zValidator('param', idParamSchema, validationHook), async (c) => {
		const { id } = c.req.valid('param')
		const result = await deleteNote(c.env, c.get('userId'), id)
		if (!result.ok) {
			return c.json({ error: result.error, code: result.code }, STATUS_BY_CODE[result.code])
		}
		return new Response(null, { status: 204 })
	})

function toResponse<T>(c: Context<AppBindings>, result: Result<T>, successStatus: 200 | 201) {
	if (result.ok) {
		return c.json(result.data, successStatus)
	}
	return c.json({ error: result.error, code: result.code }, STATUS_BY_CODE[result.code])
}
