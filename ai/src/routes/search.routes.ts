import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { AppBindings } from '../config/env'
import { requireUserId } from '../lib/user-context'
import { toResponse, validationHook } from '../lib/http'
import { findSimilarToNote, searchByQuery } from '../services/search.service'

// Семантический поиск (F8). Префикс в ai = префикс в gateway:
// - `POST /search` → gateway проксирует фронтовый `POST /ai/search`;
// - `GET /notes/:id/similar` → gateway проксирует тот же путь
//   (см. 5B-4: в gateway этот роут регистрируется ДО `GET /notes/:id`).
//
// Все запросы — под `requireUserId` (gateway ставит `x-user-id` из JWT).
// Body — domain data (query, topK), без userId.

const DEFAULT_SEARCH_TOPK = 10
const DEFAULT_SIMILAR_TOPK = 5
const MAX_TOPK = 50
const MAX_QUERY_LENGTH = 2000

const searchSchema = z.object({
	query: z.string().min(1).max(MAX_QUERY_LENGTH),
	topK: z.number().int().min(1).max(MAX_TOPK).optional(),
})

// `coerce.number()` — query-параметры приходят строками, явное преобразование.
const similarQuerySchema = z.object({
	topK: z.coerce.number().int().min(1).max(MAX_TOPK).optional(),
})

const noteIdParamSchema = z.object({ id: z.uuid() })

export const searchRoutes = new Hono<AppBindings>()
	.use('/search', requireUserId)
	.use('/notes/:id/similar', requireUserId)
	.post('/search', zValidator('json', searchSchema, validationHook), async (c) => {
		const body = c.req.valid('json')
		const hits = await searchByQuery(c.env, c.get('userId'), body.query, body.topK ?? DEFAULT_SEARCH_TOPK)
		return c.json(hits, 200)
	})
	.get(
		'/notes/:id/similar',
		zValidator('param', noteIdParamSchema, validationHook),
		zValidator('query', similarQuerySchema, validationHook),
		async (c) => {
			const { id } = c.req.valid('param')
			const { topK } = c.req.valid('query')
			const result = await findSimilarToNote(c.env, c.get('userId'), id, topK ?? DEFAULT_SIMILAR_TOPK)
			return toResponse(c, result, 200)
		},
	)
