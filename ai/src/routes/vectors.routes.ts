import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { AppBindings } from '../config/env'
import { requireUserId } from '../lib/user-context'
import { validationHook } from '../lib/http'
import { deleteNote, upsertNote, upsertGroup, deleteGroup } from '../services/vectors.service'

// Internal-роуты индексации. Вызываются из notes-воркера через Service
// Binding `AI` после успешного CRUD заметки (Phase 5B-5). Не проксируются
// через gateway — путь `/internal/*` фронту недоступен.
//
// Зод-валидация обязательна: «internal != untrusted» (правка после
// api-guardian). Контракт userId — заголовок `x-user-id`; body — domain data.

const MAX_TEXT = 1_000_000 // ~1 МБ — синхронизировано с лимитом notes-воркера.

const upsertSchema = z.object({
	noteId: z.uuid(),
	contentText: z.string().min(1).max(MAX_TEXT),
})

const deleteSchema = z.object({
	noteId: z.uuid(),
})

const groupUpsertSchema = z.object({
	groupId: z.uuid(),
	name: z.string().min(1).max(100),
	description: z.string().max(500),
})

const groupDeleteSchema = z.object({
	groupId: z.uuid(),
})

export const vectorsRoutes = new Hono<AppBindings>()
	.use('/internal/vectors/*', requireUserId)
	.post('/internal/vectors/upsert', zValidator('json', upsertSchema, validationHook), async (c) => {
		const body = c.req.valid('json')
		await upsertNote(c.env, {
			noteId: body.noteId,
			userId: c.get('userId'),
			contentText: body.contentText,
		})
		return new Response(null, { status: 204 })
	})
	.post('/internal/vectors/delete', zValidator('json', deleteSchema, validationHook), async (c) => {
		const body = c.req.valid('json')
		await deleteNote(c.env, body.noteId)
		return new Response(null, { status: 204 })
	})
	.post('/internal/vectors/group-upsert', zValidator('json', groupUpsertSchema, validationHook), async (c) => {
		const body = c.req.valid('json')
		await upsertGroup(c.env, { groupId: body.groupId, userId: c.get('userId'), name: body.name, description: body.description })
		return new Response(null, { status: 204 })
	})
	.post('/internal/vectors/group-delete', zValidator('json', groupDeleteSchema, validationHook), async (c) => {
		const body = c.req.valid('json')
		await deleteGroup(c.env, body.groupId)
		return new Response(null, { status: 204 })
	})
