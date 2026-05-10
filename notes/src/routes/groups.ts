import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { AppBindings } from '../config/env'
import { requireUserId } from '../lib/user-context'
import { triggerGroupVectorIndex } from '../lib/group-index-trigger'
import { errResponse, toResponse, validationHook } from '../lib/http'
import { createGroup, deleteGroup, listGroups, updateGroup } from '../services/groups.service'

const MAX_NAME = 100
const MAX_DESC = 500

const createSchema = z.object({
	name: z.string().min(1).max(MAX_NAME),
	description: z.string().max(MAX_DESC).optional(),
})

const updateSchema = z
	.object({
		name: z.string().min(1).max(MAX_NAME).optional(),
		description: z.string().max(MAX_DESC).optional(),
	})
	.refine((data) => Object.values(data).some((v) => v !== undefined), {
		message: 'Нужно передать хотя бы одно поле для обновления',
	})

const idParamSchema = z.object({ id: z.uuid() })

export const groupsRoutes = new Hono<AppBindings>()
	.use('*', requireUserId)
	.get('/groups', async (c) => {
		const result = await listGroups(c.env, c.get('userId'))
		if (!result.ok) return errResponse(c, result)
		for (const action of result.data.toIndex) {
			triggerGroupVectorIndex(c, action)
		}
		return c.json(result.data.groups, 200)
	})
	.post('/groups', zValidator('json', createSchema, validationHook), async (c) => {
		const result = await createGroup(c.env, c.get('userId'), c.req.valid('json'))
		if (!result.ok) return errResponse(c, result)
		triggerGroupVectorIndex(c, result.data.index)
		return c.json(result.data.group, 201)
	})
	.patch(
		'/groups/:id',
		zValidator('param', idParamSchema, validationHook),
		zValidator('json', updateSchema, validationHook),
		async (c) => {
			const { id } = c.req.valid('param')
			const result = await updateGroup(c.env, c.get('userId'), id, c.req.valid('json'))
			if (!result.ok) return errResponse(c, result)
			triggerGroupVectorIndex(c, result.data.index)
			return c.json(result.data.group, 200)
		},
	)
	.delete('/groups/:id', zValidator('param', idParamSchema, validationHook), async (c) => {
		const { id } = c.req.valid('param')
		const result = await deleteGroup(c.env, c.get('userId'), id)
		if (!result.ok) return errResponse(c, result)
		triggerGroupVectorIndex(c, result.data.index)
		return new Response(null, { status: 204 })
	})
