import type { Env } from '../config/env'
import { toReadableStream } from '../lib/ai-stream'
import type { ChatMessage } from './discuss.service'
import { getActiveModel, getPrompt } from './settings.service'

export async function streamFormatForNote(
	env: Env,
	messages: ChatMessage[],
): Promise<ReadableStream<Uint8Array>> {
	const [model, systemPrompt] = await Promise.all([
		getActiveModel(env),
		getPrompt(env, 'format-note'),
	])

	const text = messages
		.map((m) => `${m.role === 'user' ? 'Пользователь' : 'AI'}: ${m.content}`)
		.join('\n\n')

	const result = await env.AI.run(model, {
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: text },
		],
		stream: true,
		max_tokens: 4096,
	})
	return toReadableStream(result)
}
