import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { AppBindings } from '../config/env'
import { ALLOWED_MODELS } from '../config/ai-models'
import { DEFAULT_PROMPTS, type PromptKey } from '../config/prompts'
import { validationHook } from '../lib/http'
import {
	deletePromptOverride,
	listSettings,
	setActiveModel,
	setPromptOverride,
} from '../services/settings.service'

// CRUD AI-настроек (F7, Phase 5C). Префикс ai = префикс gateway (`/settings`),
// gateway проксирует «как есть» через `authenticatedProxy('AI')` без
// `internalPath`. JWT-проверка — в gateway; этот воркер userId не использует
// (настройки глобальные на инстанс, не на пользователя — см. tech-plan
// «Гибрид config + D1» и docs/modules/ai.md «Ограничения»). Поэтому на роутах
// /settings/* нет `requireUserId` — в отличие от /search и /internal/vectors/*.

const MAX_PROMPT_LENGTH = 8000

// Whitelist моделей — z.enum по `ALLOWED_MODELS`. Невалидная строка → 400.
const activeModelSchema = z.object({
	model: z.enum(ALLOWED_MODELS),
})

// Whitelist ключей промптов — `Object.keys(DEFAULT_PROMPTS)`. `z.enum`
// требует non-empty tuple `[T, ...T[]]`; компилятор сам не выводит длину
// из `Object.keys`, поэтому каст обязателен. Известно, что в `DEFAULT_PROMPTS`
// есть хотя бы один ключ (см. `config/prompts.ts`).
const PROMPT_KEYS = Object.keys(DEFAULT_PROMPTS) as [PromptKey, ...PromptKey[]]
const promptKeyParamSchema = z.object({
	key: z.enum(PROMPT_KEYS),
})

// `value` — непустой текст до 8000 симв. Пробельные строки отбрасываем на
// валидаторе (`trim().length >= 1`), чтобы сервис получал готовое значение.
const promptBodySchema = z.object({
	value: z
		.string()
		.max(MAX_PROMPT_LENGTH)
		.refine((value) => value.trim().length >= 1, {
			message: 'Значение промпта не может быть пустым',
		}),
})

export const settingsRoutes = new Hono<AppBindings>()
	.get('/settings', async (c) => {
		const view = await listSettings(c.env)
		return c.json(view, 200)
	})
	.put('/settings/active-model', zValidator('json', activeModelSchema, validationHook), async (c) => {
		const { model } = c.req.valid('json')
		await setActiveModel(c.env, model)
		const view = await listSettings(c.env)
		return c.json(view, 200)
	})
	.put(
		'/settings/prompts/:key',
		zValidator('param', promptKeyParamSchema, validationHook),
		zValidator('json', promptBodySchema, validationHook),
		async (c) => {
			const { key } = c.req.valid('param')
			const { value } = c.req.valid('json')
			await setPromptOverride(c.env, key, value.trim())
			const view = await listSettings(c.env)
			return c.json(view, 200)
		},
	)
	.delete('/settings/prompts/:key', zValidator('param', promptKeyParamSchema, validationHook), async (c) => {
		const { key } = c.req.valid('param')
		await deletePromptOverride(c.env, key)
		return new Response(null, { status: 204 })
	})
