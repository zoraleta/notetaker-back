import { Hono } from 'hono'
import type { AppBindings } from '../config/env'
import { DEFAULT_PROMPTS } from '../config/prompts'
import { getActiveModel, getPrompt } from '../services/settings.service'

// Временный smoke-эндпоинт для проверки гибрида settings (5A).
// УДАЛЯЕТСЯ В 5C, когда `/settings/*` даст настоящий CRUD. Не подключай к gateway.
//
// `/__smoke/embed` удалён в 5B — его покрывает реальный
// `POST /internal/vectors/upsert` + `POST /search`.
export const smokeRoutes = new Hono<AppBindings>()
	.get('/__smoke/settings', async (c) => {
		const activeModel = await getActiveModel(c.env)
		const summarizePrompt = await getPrompt(c.env, 'summarize')
		return c.json({
			activeModel,
			summarizePromptHead: summarizePrompt.slice(0, 80),
			summarizeIsDefault: summarizePrompt === DEFAULT_PROMPTS.summarize,
		})
	})
