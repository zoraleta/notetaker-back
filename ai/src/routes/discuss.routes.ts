import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { AppBindings } from '../config/env'
import { requireUserId } from '../lib/user-context'
import { toResponse, validationHook } from '../lib/http'
import { streamDiscuss } from '../services/discuss.service'
import { packDialogIntoProject } from '../services/pack.service'

// F5 discuss + pack-into-project (Phase 5G).
//
// `/discuss` требует `requireUserId` — namespace в Vectorize и SVC binding
// к notes без userId не работают. `/pack-into-project` userId не использует
// (чистая трансформация text-in/json-out, как `/summarize`); JWT в gateway
// остаётся guard'ом «авторизован — может дёргать LLM».

const MAX_MESSAGE_LENGTH = 8000
const MAX_MESSAGES = 50
const MAX_DIALOG = 100_000

const messageSchema = z.object({
	role: z.enum(['user', 'assistant']),
	content: z.string().min(1).max(MAX_MESSAGE_LENGTH),
})

const discussSchema = z.object({
	noteId: z.uuid(),
	messages: z.array(messageSchema).min(1).max(MAX_MESSAGES),
})

const packSchema = z.object({
	dialog: z.string().min(1).max(MAX_DIALOG),
})

export const discussRoutes = new Hono<AppBindings>()
	.use('/discuss', requireUserId)
	.post('/discuss', zValidator('json', discussSchema, validationHook), async (c) => {
		const { noteId, messages } = c.req.valid('json')
		const stream = await streamDiscuss(c.env, c.get('userId'), noteId, messages)
		// Не оборачиваем в TransformStream — Workers AI уже отдаёт SSE,
		// двойная обёртка удвоила бы парсинг на фронте (как в /summarize).
		return new Response(stream, {
			headers: {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache',
			},
		})
	})
	.post('/pack-into-project', zValidator('json', packSchema, validationHook), async (c) => {
		const result = await packDialogIntoProject(c.env, c.req.valid('json').dialog)
		return toResponse(c, result, 200)
	})
