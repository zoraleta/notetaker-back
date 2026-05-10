import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { AppBindings } from '../config/env'
import { toResponse, validationHook } from '../lib/http'
import { structurizeNote } from '../services/structurize.service'

const structurizeSchema = z.object({
	text: z.string().min(1).max(50_000),
})

export const structurizeRoutes = new Hono<AppBindings>().post(
	'/structurize',
	zValidator('json', structurizeSchema, validationHook),
	async (c) => {
		const { text } = c.req.valid('json')
		const result = await structurizeNote(c.env, text)
		return toResponse(c, result, 200)
	},
)
