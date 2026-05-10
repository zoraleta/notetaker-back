import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { AppBindings } from '../config/env'
import { requireUserId } from '../lib/user-context'
import { errResponse, toResponse, validationHook } from '../lib/http'
import {
	createProject,
	deleteProject,
	fromPackProject,
	getProject,
	listProjects,
	updateProject,
} from '../services/projects.service'

const MAX_NAME = 200
const MAX_DESCRIPTION = 2000
const MAX_GOAL = 2000
const MAX_STAGE_TITLE = 500
const MAX_OPEN_QUESTION = 1000
const MAX_SOURCE_NOTE_IDS = 100

const stageSchema = z.object({
	title: z.string().min(1).max(MAX_STAGE_TITLE),
	done: z.boolean(),
})

const createSchema = z.object({
	name: z.string().min(1).max(MAX_NAME),
	description: z.string().max(MAX_DESCRIPTION).optional(),
})

const fromPackSchema = z.object({
	name: z.string().min(1).max(MAX_NAME),
	description: z.string().max(MAX_DESCRIPTION).optional(),
	pack: z.object({
		goal: z.string().max(MAX_GOAL).optional(),
		stages: z.array(stageSchema).optional(),
		openQuestions: z.array(z.string().min(1).max(MAX_OPEN_QUESTION)).optional(),
	}),
	sourceNoteIds: z.array(z.string().uuid()).max(MAX_SOURCE_NOTE_IDS),
})

const updateSchema = z
	.object({
		name: z.string().min(1).max(MAX_NAME).optional(),
		description: z.string().max(MAX_DESCRIPTION).optional(),
		goal: z.string().max(MAX_GOAL).nullable().optional(),
		stages: z.array(stageSchema).optional(),
		openQuestions: z.array(z.string().min(1).max(MAX_OPEN_QUESTION)).optional(),
	})
	.refine((data) => Object.values(data).some((v) => v !== undefined), {
		message: 'Нужно передать хотя бы одно поле для обновления',
	})

const idParamSchema = z.object({ id: z.string().uuid() })

export const projectsRoutes = new Hono<AppBindings>()
	.use('*', requireUserId)
	// from-pack ПЕРЕД /:id — Hono использует first-match, иначе /:id поглотит from-pack.
	.post('/projects/from-pack', zValidator('json', fromPackSchema, validationHook), async (c) => {
		const result = await fromPackProject(c.env, c.get('userId'), c.req.valid('json'))
		return toResponse(c, result, 201)
	})
	.post('/projects', zValidator('json', createSchema, validationHook), async (c) => {
		const result = await createProject(c.env, c.get('userId'), c.req.valid('json'))
		return toResponse(c, result, 201)
	})
	.get('/projects', async (c) => {
		const result = await listProjects(c.env, c.get('userId'))
		return toResponse(c, result, 200)
	})
	.get('/projects/:id', zValidator('param', idParamSchema, validationHook), async (c) => {
		const { id } = c.req.valid('param')
		const result = await getProject(c.env, c.get('userId'), id)
		return toResponse(c, result, 200)
	})
	.patch(
		'/projects/:id',
		zValidator('param', idParamSchema, validationHook),
		zValidator('json', updateSchema, validationHook),
		async (c) => {
			const { id } = c.req.valid('param')
			const result = await updateProject(c.env, c.get('userId'), id, c.req.valid('json'))
			return toResponse(c, result, 200)
		},
	)
	.delete('/projects/:id', zValidator('param', idParamSchema, validationHook), async (c) => {
		const { id } = c.req.valid('param')
		const result = await deleteProject(c.env, c.get('userId'), id)
		if (!result.ok) return errResponse(c, result)
		return new Response(null, { status: 204 })
	})
