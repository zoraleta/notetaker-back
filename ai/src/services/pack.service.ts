import { z } from 'zod'
import type { Env } from '../config/env'
import { err, ok, type Result } from '../lib/result'
import { getActiveModel, getPrompt } from './settings.service'

// F5 «упаковать в проект» (Phase 5G). Без стрима: ждём полный ответ модели,
// парсим JSON, валидируем по Zod-схеме. Возвращаем структурированный объект
// для фронта (создание проекта в Phase 7) или 502 при поломке формата.
//
// Жёсткая Zod-валидация — потому что это «контракт между LLM и фронтом».
// Модель может вернуть валидный JSON (`JSON.parse` не упадёт), но с лишними
// полями или неправильной формой. `safeParse` ловит оба случая одинаково,
// и это лучше, чем доверять «JSON-парсинг прошёл».

const projectPackSchema = z.object({
	goal: z.string().min(1),
	stages: z.array(z.object({ title: z.string().min(1), done: z.boolean() })),
	openQuestions: z.array(z.string().min(1)),
})

export type ProjectPack = z.infer<typeof projectPackSchema>

export async function packDialogIntoProject(env: Env, dialog: string): Promise<Result<ProjectPack>> {
	const [model, systemPrompt] = await Promise.all([
		getActiveModel(env),
		getPrompt(env, 'pack-into-project'),
	])

	const response = (await env.AI.run(model, {
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: dialog },
		],
	})) as { response?: string }

	const raw = typeof response.response === 'string' ? response.response : ''
	const cleaned = extractJsonBlock(raw)

	let parsed: unknown
	try {
		parsed = JSON.parse(cleaned)
	} catch {
		return err('Не удалось распарсить ответ модели', 'EXTERNAL')
	}

	const validated = projectPackSchema.safeParse(parsed)
	if (!validated.success) {
		return err('Ответ модели не соответствует ожидаемой схеме проекта', 'EXTERNAL')
	}
	return ok(validated.data)
}

// Модели иногда оборачивают JSON в markdown (```json ... ```), добавляют
// преамбулу «Вот ответ:» или хвост из извинений. Вытаскиваем диапазон от
// первого `{` до последнего `}` — этого хватает для llama-3.1/3.3, которые
// в практике 5G smoke возвращают либо чистый JSON, либо с минимальной обвязкой.
// Если модель вернёт строго JSON, substring совпадёт со входом.
function extractJsonBlock(raw: string): string {
	const start = raw.indexOf('{')
	const end = raw.lastIndexOf('}')
	if (start === -1 || end === -1 || end < start) return raw
	return raw.substring(start, end + 1)
}
