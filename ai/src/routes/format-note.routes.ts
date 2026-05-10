import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { AppBindings } from '../config/env'
import { validationHook } from '../lib/http'
import { streamFormatForNote } from '../services/format-note.service'

const MAX_MESSAGE_LENGTH = 8000
const MAX_MESSAGES = 50

const messageSchema = z.object({
	role: z.enum(['user', 'assistant']),
	content: z.string().min(1).max(MAX_MESSAGE_LENGTH),
})

const formatNoteSchema = z.object({
	messages: z.array(messageSchema).min(1).max(MAX_MESSAGES),
})

export const formatNoteRoutes = new Hono<AppBindings>().post(
	'/format-for-note',
	zValidator('json', formatNoteSchema, validationHook),
	async (c) => {
		const { messages } = c.req.valid('json')
		const stream = await streamFormatForNote(c.env, messages)
		return new Response(stream, {
			headers: {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache',
			},
		})
	},
)
