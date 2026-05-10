import type { Env } from '../config/env'
import { fetchNoteContentText } from '../db/notes.client'
import { extractNeighborMatches, queryNoteVectorsById } from '../db/vectors.queries'
import { toReadableStream } from '../lib/ai-stream'
import { err, ok, type Result } from '../lib/result'
import { getActiveModel, getPrompt } from './settings.service'

// F5 «обсуди идею» (Phase 5G). Стриминг чата с RAG-контекстом из соседних
// заметок юзера. Структура: систем-промпт `discuss` → отдельный system-блок
// с RAG-контекстом → история сообщений пользователя. RAG отдаём отдельным
// system-блоком, а не через `${variables}` в строку промпта — так промпт
// остаётся чистым шаблоном из getPrompt без рантайм-склейки.
//
// Graceful degrade: если у заметки нет вектора (только что создана,
// индексация в фоне) → отвечаем без RAG. Если k из N соседей упали при
// `GET /notes/:id` (soft-delete между queryById и fetch, или notes-воркер
// недоступен) → RAG-подмножество из (N-k) удачных. Если все N упали —
// стрим без RAG. /discuss никогда не возвращает 502 из-за RAG.

const RAG_TOPK = 5

export interface ChatMessage {
	role: 'user' | 'assistant'
	content: string
}

type LlmMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export async function streamDiscuss(
	env: Env,
	userId: string,
	noteId: string,
	userMessages: ChatMessage[],
): Promise<Result<ReadableStream<Uint8Array>>> {
	// Cross-user guard: до запроса к LLM проверяем, что noteId принадлежит
	// юзеру (через SVC binding к notes под x-user-id). Без этого Bob может
	// дёрнуть `/discuss` с чужим noteId — стрим всё равно пошёл бы (RAG
	// просто остался бы пустым), но контракт DoD требует 404 на чужой.
	const ownText = await fetchNoteContentText(env, userId, noteId)
	if (ownText === null) {
		return err('Заметка не найдена', 'NOT_FOUND')
	}

	// Параллельно: настройки + RAG. RAG-цепочка (queryById + N×GET notes)
	// — самая медленная операция, не дожидаемся её последовательно.
	const [model, systemPrompt, ragTexts] = await Promise.all([
		getActiveModel(env),
		getPrompt(env, 'discuss'),
		gatherRagContext(env, userId, noteId),
	])

	const messages: LlmMessage[] = [{ role: 'system', content: systemPrompt }]
	if (ragTexts.length > 0) {
		messages.push({ role: 'system', content: buildRagBlock(ragTexts) })
	}
	for (const msg of userMessages) {
		messages.push(msg)
	}

	const aiResult = await env.AI.run(model, { messages, stream: true })
	return ok(toReadableStream(aiResult))
}

async function gatherRagContext(env: Env, userId: string, noteId: string): Promise<string[]> {
	const matches = await queryNoteVectorsById(env.VECTORIZE, noteId, {
		userId,
		topK: RAG_TOPK + 1, // +1 чтобы запас под self, который выкидываем ниже
	})
	const neighbors = extractNeighborMatches(matches, noteId, RAG_TOPK)
	if (neighbors.length === 0) return []

	// N×GET через SVC binding — в одном runtime, миллисекунды на вызов.
	// Promise.all не блокируется на медленном соседе; null'ы (404/403/soft-fail)
	// фильтруем, что и реализует graceful degrade.
	const fetched = await Promise.all(
		neighbors.map((n) => fetchNoteContentText(env, userId, n.noteId)),
	)
	return fetched.filter((text): text is string => text !== null && text.length > 0)
}

function buildRagBlock(texts: string[]): string {
	// Маркеры `===Заметка N===` явно отделяют блоки контекста, чтобы модель
	// не путала их с системными инструкциями и не цитировала границы.
	const blocks = texts.map((t, i) => `===Заметка ${i + 1}===\n${t}`).join('\n\n')
	return `Контекст из других заметок пользователя:\n\n${blocks}`
}
