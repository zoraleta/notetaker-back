import { Hono } from 'hono'
import type { AppBindings } from '../config/env'
import {
	EMBEDDING_DIMENSIONS,
	EMBEDDING_MODEL,
} from '../config/ai-models'
import { DEFAULT_PROMPTS } from '../config/prompts'
import { getActiveModel, getPrompt } from '../services/settings.service'

// Временные smoke-эндпоинты для проверки 5A. Покрывают DoD:
// - env.AI.run(EMBEDDING_MODEL) возвращает 1024-мерный вектор;
// - getActiveModel/getPrompt отражают гибрид «дефолт ↔ D1 override».
//
// УДАЛЯЮТСЯ В 5B (vectors.routes.ts даёт настоящий векторный pipeline)
// и 5C (settings.routes.ts даёт настоящий CRUD). Не подключай к gateway.
export const smokeRoutes = new Hono<AppBindings>()
	.get('/__smoke/embed', async (c) => {
		// Workers AI bge-m3 возвращает { shape: [N, 1024], data: number[][] }.
		const response = (await c.env.AI.run(EMBEDDING_MODEL, { text: ['hello'] })) as {
			shape: number[]
			data: number[][]
		}
		const vector = response.data[0]
		return c.json({
			model: EMBEDDING_MODEL,
			expectedDimensions: EMBEDDING_DIMENSIONS,
			actualDimensions: vector?.length ?? 0,
			ok: vector?.length === EMBEDDING_DIMENSIONS,
		})
	})
	.get('/__smoke/settings', async (c) => {
		const activeModel = await getActiveModel(c.env)
		const summarizePrompt = await getPrompt(c.env, 'summarize')
		return c.json({
			activeModel,
			summarizePromptHead: summarizePrompt.slice(0, 80),
			summarizeIsDefault: summarizePrompt === DEFAULT_PROMPTS.summarize,
		})
	})
