import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { AppBindings } from '../config/env'
import { requireUserId } from '../lib/user-context'
import { validationHook } from '../lib/http'
import { classifyNote } from '../services/classify.service'

// F3 auto-classification (Phase 5E). Префикс ai = `/classify`, gateway
// проксирует фронтовый `POST /ai/classify` через `authenticatedProxy('AI', '/classify')`.
// Запрос идёт от создания заметки на фронте: фронт получает suggestion
// `projectId | null` синхронно (не часть `waitUntil`), чтобы юзер увидел
// предложение в UI сразу.
//
// Требует `requireUserId`: классификация идёт по соседям в namespace юзера.
// Body — domain data (contentText), userId — заголовком x-user-id.

const MAX_TEXT = 1_000_000

const classifySchema = z.object({
	contentText: z.string().min(1).max(MAX_TEXT),
})

export const classifyRoutes = new Hono<AppBindings>()
	.use('/classify', requireUserId)
	.post('/classify', zValidator('json', classifySchema, validationHook), async (c) => {
		const result = await classifyNote(c.env, c.get('userId'), c.req.valid('json').contentText)
		return c.json(result, 200)
	})
