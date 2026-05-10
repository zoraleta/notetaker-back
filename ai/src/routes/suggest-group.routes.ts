import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { AppBindings } from '../config/env'
import { requireUserId } from '../lib/user-context'
import { validationHook } from '../lib/http'
import { suggestGroups } from '../services/suggest-group.service'

// Internal-роут предложения группы по тексту заметки (Phase 8 Groups).
// Gateway проксирует `POST /ai/suggest-group` → здесь `/suggest-group`.
// userId — из заголовка x-user-id (установлен gateway после JWT).

const DEFAULT_TOPK = 3
const MAX_TOPK = 10
const MAX_TEXT = 1_000_000

const suggestGroupSchema = z.object({
	noteText: z.string().min(1).max(MAX_TEXT),
	topK: z.number().int().min(1).max(MAX_TOPK).optional(),
})

export const suggestGroupRoutes = new Hono<AppBindings>()
	.use('/suggest-group', requireUserId)
	.post('/suggest-group', zValidator('json', suggestGroupSchema, validationHook), async (c) => {
		const { noteText, topK } = c.req.valid('json')
		const suggestions = await suggestGroups(c.env, c.get('userId'), noteText, topK ?? DEFAULT_TOPK)
		return c.json(suggestions, 200)
	})
