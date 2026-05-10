import type { Env } from '../config/env'
import { fetchNoteContentText } from '../db/notes.client'
import { err, ok, type Result } from '../lib/result'
import { getActiveModel, getPrompt } from './settings.service'

const MAX_NOTE_LENGTH = 50_000

export async function mergeNotes(
	env: Env,
	userId: string,
	activeNoteId: string,
	noteIds: string[],
): Promise<Result<string>> {
	// Собираем тексты параллельно: activeNote + выбранные заметки.
	// fetchNoteContentText soft-fail'ит (null) при 404/403 — фильтруем.
	const [activeText, ...selectedTexts] = await Promise.all([
		fetchNoteContentText(env, userId, activeNoteId),
		...noteIds.map((id) => fetchNoteContentText(env, userId, id)),
	])

	if (activeText === null) {
		return err('Заметка не найдена', 'NOT_FOUND')
	}

	const validSelected = selectedTexts.filter((t): t is string => t !== null && t.trim().length > 0)
	if (validSelected.length === 0) {
		return err('Ни одна из выбранных заметок недоступна', 'NOT_FOUND')
	}

	const [model, systemPrompt] = await Promise.all([
		getActiveModel(env),
		getPrompt(env, 'merge'),
	])

	const notesBlock = [activeText, ...validSelected]
		.map((text, i) => `===Заметка ${i + 1}===\n${text.slice(0, MAX_NOTE_LENGTH)}`)
		.join('\n\n')

	const response = (await env.AI.run(model, {
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: notesBlock },
		],
		max_tokens: 2048,
	})) as { response?: string }

	const merged = typeof response.response === 'string' ? response.response.trim() : ''
	if (!merged) {
		return err('Модель вернула пустой ответ', 'EXTERNAL')
	}

	return ok(merged)
}
