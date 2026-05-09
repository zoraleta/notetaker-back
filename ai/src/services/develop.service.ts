import type { Env } from '../config/env'
import { fetchUserNotes } from '../db/notes.client'
import { NO_PROJECT, queryNoteVectorsById, vectorIdForNote, type NoteVectorMetadata } from '../db/vectors.queries'

// F4 «develop-suggestions» (Phase 5F). На дашборде показываем 2-3 коротких
// заметки с похожими соседями — кандидаты на «дописать/развить тему».
//
// Theme-deduplication поверх «top по числу соседей» из спеки: тема с большим
// числом коротких заметок съела бы все слоты suggestions, дашборд показал
// бы три кандидата из одного проекта вместо разнообразия. Группируем по
// projectId (NO_PROJECT — отдельный bucket «без проекта»), оставляем top-1
// в каждой группе.

const SHORT_NOTE_MAX = 600
const CANDIDATE_LIMIT = 20
const NEIGHBORS_TOPK = 5
const NEIGHBOR_SCORE_MIN = 0.65
const SUGGESTIONS_LIMIT = 3

export interface NeighborHit {
	noteId: string
	score: number
}

export interface DevelopCandidate {
	noteId: string
	neighbors: NeighborHit[]
}

// Внутренний тип на время сборки — projectId нужен для dedup, но
// в публичный ответ не попадает (DoD-формат: noteId + neighbors).
interface CandidateWithTheme extends DevelopCandidate {
	projectId: string | null
}

export async function findDevelopCandidates(env: Env, userId: string): Promise<DevelopCandidate[]> {
	const notes = await fetchUserNotes(env, userId)
	const shortNotes = notes.filter((n) => n.contentText.length < SHORT_NOTE_MAX).slice(0, CANDIDATE_LIMIT)

	// Параллельно собираем соседей для всех кандидатов: каждый запрос —
	// отдельный round-trip к Vectorize, последовательный await дал бы
	// N × ~50ms на дашборд-hot-path. На 20 кандидатах разница ощутима.
	const collected = await Promise.all(
		shortNotes.map(async (note) => {
			const neighbors = await collectNeighbors(env, userId, note.id)
			return neighbors.length === 0
				? null
				: ({ noteId: note.id, projectId: note.projectId, neighbors } satisfies CandidateWithTheme)
		}),
	)
	const candidates = collected.filter((c): c is CandidateWithTheme => c !== null)

	// Group-by projectId: при равном числе соседей побеждает первый
	// встреченный (свежайший — shortNotes уже в `updatedAt DESC`).
	// При большем числе соседей — перезаписываем.
	const bestPerTheme = new Map<string, CandidateWithTheme>()
	for (const candidate of candidates) {
		const themeKey = candidate.projectId ?? NO_PROJECT
		const existing = bestPerTheme.get(themeKey)
		if (!existing || candidate.neighbors.length > existing.neighbors.length) {
			bestPerTheme.set(themeKey, candidate)
		}
	}

	return Array.from(bestPerTheme.values())
		.sort((a, b) => b.neighbors.length - a.neighbors.length)
		.slice(0, SUGGESTIONS_LIMIT)
		.map(({ noteId, neighbors }) => ({ noteId, neighbors }))
}

async function collectNeighbors(env: Env, userId: string, noteId: string): Promise<NeighborHit[]> {
	const result = await queryNoteVectorsById(env.VECTORIZE, noteId, {
		userId,
		topK: NEIGHBORS_TOPK + 1, // +1 чтобы запас под self, который выкидываем ниже
	})
	const selfId = vectorIdForNote(noteId)
	const neighbors: NeighborHit[] = []
	for (const match of result.matches) {
		if (match.id === selfId) continue
		if (match.score < NEIGHBOR_SCORE_MIN) continue
		const metadata = match.metadata as NoteVectorMetadata | undefined
		if (!metadata || typeof metadata.noteId !== 'string') continue
		neighbors.push({ noteId: metadata.noteId, score: match.score })
		if (neighbors.length >= NEIGHBORS_TOPK) break
	}
	return neighbors
}
