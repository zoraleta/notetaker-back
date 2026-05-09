import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { AppBindings } from '../config/env'
import { validationHook } from '../lib/http'
import { streamSummarize } from '../services/summarize.service'

// F1 саммари (Phase 5D). Префикс ai = `/summarize`, gateway проксирует
// фронтовый `POST /ai/summarize` через `authenticatedProxy('AI', '/summarize')`.
//
// Не требует `requireUserId` — саммари статьи не привязано к данным юзера
// (это чистая трансформация text-in/text-out, без D1 и Vectorize).
// JWT в gateway остаётся как guard «авторизован — может дёргать LLM».
//
// Лимиты длины: < 100 — мало смысла суммировать; > 200 000 — приближение
// к контекстному окну небольших моделей и предохранитель от случайного
// спама. Реальный лимит токенов проверит сама Workers AI (вернёт ошибку
// модели — пройдёт через `app.onError` → 500).

const MIN_TEXT = 100
const MAX_TEXT = 200_000

const summarizeSchema = z.object({
	text: z.string().min(MIN_TEXT).max(MAX_TEXT),
})

export const summarizeRoutes = new Hono<AppBindings>().post(
	'/summarize',
	zValidator('json', summarizeSchema, validationHook),
	async (c) => {
		const { text } = c.req.valid('json')
		const stream = await streamSummarize(c.env, text)
		// Workers AI отдаёт уже SSE-форматированный поток (data: {...}\n\n).
		// Не оборачиваем в TransformStream — это удваивало бы парсинг на фронте.
		return new Response(stream, {
			headers: {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache',
			},
		})
	},
)
