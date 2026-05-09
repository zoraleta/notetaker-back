import type { Env } from '../config/env'
import { embedText } from './embedding.service'
import {
	NO_PROJECT,
	queryNoteVectors,
	queryNoteVectorsById,
	vectorIdForNote,
	type NoteVectorMetadata,
} from '../db/vectors.queries'

// Shape ответа для фронта. projectId возвращаем как `null`, если в metadata
// у заметки лежит NO_PROJECT (`''`) — фронту удобнее однообразный
// `if (projectId)`, чем сравнивать с пустой строкой.
export interface SearchHit {
	noteId: string
	score: number
	projectId: string | null
}

// Семантический поиск по тексту запроса. Эмбеддит query через bge-m3,
// затем `queryNoteVectors` возвращает топ-K с двойным guard (namespace+filter).
export async function searchByQuery(
	env: Env,
	userId: string,
	query: string,
	topK: number,
): Promise<SearchHit[]> {
	const values = await embedText(env, query)
	const result = await queryNoteVectors(env.VECTORIZE, values, { userId, topK })
	return result.matches.map(toSearchHit).filter((hit): hit is SearchHit => hit !== null)
}

// «Похожие заметки»: поиск по уже существующему вектору заметки. Сама
// заметка-источник всегда в топе с score=1.0 (тот же вектор), её исключаем.
// Берём `topK + 1` из Vectorize, чтобы после выкидывания self остался топ-K.
//
// Если у заметки нет вектора (только что создана, индексация в фоне) —
// `queryById` отдаёт пустой `matches`, и мы возвращаем `[]` без падения.
export async function findSimilarToNote(
	env: Env,
	userId: string,
	noteId: string,
	topK: number,
): Promise<SearchHit[]> {
	const result = await queryNoteVectorsById(env.VECTORIZE, noteId, {
		userId,
		topK: topK + 1,
	})
	const selfId = vectorIdForNote(noteId)
	return result.matches
		.filter((match) => match.id !== selfId)
		.slice(0, topK)
		.map(toSearchHit)
		.filter((hit): hit is SearchHit => hit !== null)
}

// Приведение match → SearchHit. Защитная проверка: если metadata пуста
// или невалидна (вектор записан старой версией кода с другой схемой),
// возвращаем null — наверху отфильтруется. Это страховка, а не норма.
function toSearchHit(match: VectorizeMatch): SearchHit | null {
	const metadata = match.metadata as NoteVectorMetadata | undefined
	if (!metadata || typeof metadata.noteId !== 'string') {
		return null
	}
	const projectId =
		typeof metadata.projectId === 'string' && metadata.projectId !== NO_PROJECT
			? metadata.projectId
			: null
	return {
		noteId: metadata.noteId,
		score: match.score,
		projectId,
	}
}
