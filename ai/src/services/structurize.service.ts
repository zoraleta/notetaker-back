import type { Env } from '../config/env'
import { err, ok, type Result } from '../lib/result'
import { getActiveModel, getPrompt } from './settings.service'

const MAX_NOTE_LENGTH = 50_000

export async function structurizeNote(env: Env, text: string): Promise<Result<{ structured: string }>> {
	const [model, systemPrompt] = await Promise.all([
		getActiveModel(env),
		getPrompt(env, 'structurize'),
	])

	const response = (await env.AI.run(model, {
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: text.slice(0, MAX_NOTE_LENGTH) },
		],
		max_tokens: 4096,
	})) as { response?: string }

	const structured = typeof response.response === 'string' ? response.response.trim() : ''
	if (!structured) {
		return err('Модель вернула пустой ответ', 'EXTERNAL')
	}

	return ok({ structured })
}
