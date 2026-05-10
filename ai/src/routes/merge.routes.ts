import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { AppBindings } from '../config/env'
import { requireUserId } from '../lib/user-context'
import { toResponse, validationHook } from '../lib/http'
import { mergeNotes } from '../services/merge.service'

const mergeSchema = z.object({
	activeNoteId: z.string().uuid(),
	noteIds: z.array(z.string().uuid()).min(1).max(10),
})

export const mergeRoutes = new Hono<AppBindings>()
	.use('/merge', requireUserId)
	.post('/merge', zValidator('json', mergeSchema, validationHook), async (c) => {
		const { activeNoteId, noteIds } = c.req.valid('json')
		const result = await mergeNotes(c.env, c.get('userId'), activeNoteId, noteIds)
		return toResponse(c, result, 200)
	})
