import type { Env } from '../config/env'
import { toReadableStream } from '../lib/ai-stream'
import { getActiveModel, getPrompt } from './settings.service'

// Стриминг саммари статьи (F1, Phase 5D). Активная модель и системный
// промпт читаются из гибрида config+D1 (см. settings.service); меняются
// через `/settings/*` без редеплоя. Сам поток воркер не парсит — формат
// SSE задаётся уже Workers AI и проходит через роут как есть.
export async function streamSummarize(env: Env, text: string): Promise<ReadableStream<Uint8Array>> {
	const [model, systemPrompt] = await Promise.all([getActiveModel(env), getPrompt(env, 'summarize')])

	const result = await env.AI.run(model, {
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: text },
		],
		stream: true,
	})
	return toReadableStream(result)
}
