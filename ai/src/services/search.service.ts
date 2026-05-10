import type { Env } from '../config/env'
import { embedText } from './embedding.service'
import { fetchNoteContentText, fetchNoteSummary } from '../db/notes.client'
import { err, ok, type Result } from '../lib/result'
import {
	NO_PROJECT,
	queryNoteVectors,
	queryNoteVectorsById,
	vectorIdForNote,
	type NoteVectorMetadata,
} from '../db/vectors.queries'

// Минимальный cosine similarity для «похожих заметок». Ниже этого порога
// результат считается нерелевантным и не возвращается фронту.
const MIN_SIMILAR_SCORE = 0.5

// Shape ответа для фронта. projectId возвращаем как `null`, если в metadata
// у заметки лежит NO_PROJECT (`''`) — фронту удобнее однообразный
// `if (projectId)`, чем сравнивать с пустой строкой.
export interface SearchHit {
	noteId: string
	score: number
	projectId: string | null
}

// Shape для «похожих заметок» — обогащённый хит с данными из notes-воркера.
export interface SimilarNoteHit {
	id: string
	title: string
	score: number
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
// Cross-user guard: до запроса в Vectorize проверяем, что noteId принадлежит
// юзеру (через SVC binding к notes под x-user-id). Без этого `queryById`
// находит чужой вектор по глобальному id и возвращает соседей из namespace
// текущего юзера — это не утечка контента, но раскрывает сам факт
// существования id в чужом namespace и нарушает контракт «404 на чужой».
//
// Если у заметки нет вектора (только что создана, индексация в фоне) —
// `queryById` отдаёт пустой `matches`, возвращаем `ok([])` без падения.
export async function findSimilarToNote(
	env: Env,
	userId: string,
	noteId: string,
	topK: number,
): Promise<Result<SimilarNoteHit[]>> {
	const exists = await fetchNoteContentText(env, userId, noteId)
	if (exists === null) {
		return err('Заметка не найдена', 'NOT_FOUND')
	}
	const result = await queryNoteVectorsById(env.VECTORIZE, noteId, {
		userId,
		topK: topK + 1,
	})
	const selfId = vectorIdForNote(noteId)
	const hits = result.matches
		.filter((match) => match.id !== selfId && match.score >= MIN_SIMILAR_SCORE)
		.slice(0, topK)
		.map(toSearchHit)
		.filter((hit): hit is SearchHit => hit !== null)
	// Обогащаем хиты данными заметок из notes-воркера параллельно.
	// Soft-fail: если notes вернул null (404, 5xx), хит выкидывается.
	const enriched = await Promise.all(
		hits.map(async (hit) => {
			const summary = await fetchNoteSummary(env, userId, hit.noteId)
			if (!summary) return null
			return { id: summary.id, title: summary.title, score: hit.score }
		}),
	)
	return ok(enriched.filter((h): h is SimilarNoteHit => h !== null))
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
