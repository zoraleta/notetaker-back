import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { AppBindings } from '../config/env'
import { requireUserId } from '../lib/user-context'
import { STATUS_BY_CODE, validationHook } from '../lib/http'
import { streamDiscuss } from '../services/discuss.service'

const MAX_MESSAGE_LENGTH = 8000
const MAX_MESSAGES = 50

const messageSchema = z.object({
	role: z.enum(['user', 'assistant']),
	content: z.string().min(1).max(MAX_MESSAGE_LENGTH),
})

const discussSchema = z.object({
	noteId: z.uuid(),
	messages: z.array(messageSchema).min(1).max(MAX_MESSAGES),
})

export const discussRoutes = new Hono<AppBindings>()
	.use('/discuss', requireUserId)
	.post('/discuss', zValidator('json', discussSchema, validationHook), async (c) => {
		const { noteId, messages } = c.req.valid('json')
		const result = await streamDiscuss(c.env, c.get('userId'), noteId, messages)
		if (!result.ok) {
			return c.json({ error: result.error, code: result.code }, STATUS_BY_CODE[result.code])
		}
		return new Response(result.data, {
			headers: {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache',
			},
		})
	})
