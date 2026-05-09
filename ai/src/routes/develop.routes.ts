import { Hono } from 'hono'
import type { AppBindings } from '../config/env'
import { requireUserId } from '../lib/user-context'
import { findDevelopCandidates } from '../services/develop.service'

// F4 «развей тему» (Phase 5F). Префикс ai = `/develop-suggestions`,
// gateway проксирует фронтовый `GET /ai/develop-suggestions`.
//
// Требует `requireUserId`: выборка коротких заметок и поиск соседей идут
// в namespace юзера. Без query-параметров: лимиты (20 кандидатов, top-3
// suggestions, score > 0.65) — константы в сервисе.

export const developRoutes = new Hono<AppBindings>()
	.use('/develop-suggestions', requireUserId)
	.get('/develop-suggestions', async (c) => {
		const candidates = await findDevelopCandidates(c.env, c.get('userId'))
		return c.json(candidates, 200)
	})
