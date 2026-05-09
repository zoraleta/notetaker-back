import type { Env } from '../config/env'
import { getActiveModel, getPrompt } from './settings.service'

// Стриминг саммари статьи (F1, Phase 5D). Активная модель и системный
// промпт читаются из гибрида config+D1 (см. settings.service); меняются
// через `/settings/*` без редеплоя. Сам поток воркер не парсит — формат
// SSE задаётся уже Workers AI и проходит через роут как есть.
export async function streamSummarize(env: Env, text: string): Promise<ReadableStream<Uint8Array>> {
	const [model, systemPrompt] = await Promise.all([getActiveModel(env), getPrompt(env, 'summarize')])

	// `env.AI.run` с `stream: true` всегда возвращает ReadableStream, но
	// типизация workers-types не различает overload по флагу `stream` —
	// фиксированный output type `AiTextGenerationOutput`. Каст через unknown,
	// чтобы TS не ругался на «несовпадение форм».
	const result = await env.AI.run(model, {
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: text },
		],
		stream: true,
	})
	return result as unknown as ReadableStream<Uint8Array>
}
