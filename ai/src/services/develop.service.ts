import type { Env } from '../config/env'
import { fetchUserNotes } from '../db/notes.client'
import { extractNeighborMatches, queryNoteVectorsById } from '../db/vectors.queries'

// F4 «develop-suggestions» (Phase 5F). На дашборде показываем 2-3 коротких
// заметки с похожими соседями — кандидаты на «дописать/развить тему».

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

export async function findDevelopCandidates(env: Env, userId: string): Promise<DevelopCandidate[]> {
	const notes = await fetchUserNotes(env, userId)
	const shortNotes = notes.filter((n) => n.contentText.length < SHORT_NOTE_MAX).slice(0, CANDIDATE_LIMIT)

	const collected = await Promise.all(
		shortNotes.map(async (note) => {
			const neighbors = await collectNeighbors(env, userId, note.id)
			return neighbors.length === 0 ? null : { noteId: note.id, neighbors }
		}),
	)

	return collected
		.filter((c): c is DevelopCandidate => c !== null)
		.sort((a, b) => b.neighbors.length - a.neighbors.length)
		.slice(0, SUGGESTIONS_LIMIT)
}

async function collectNeighbors(env: Env, userId: string, noteId: string): Promise<NeighborHit[]> {
	const result = await queryNoteVectorsById(env.VECTORIZE, noteId, {
		userId,
		topK: NEIGHBORS_TOPK + 1,
	})
	return extractNeighborMatches(result, noteId, NEIGHBORS_TOPK).filter(
		(n) => n.score >= NEIGHBOR_SCORE_MIN,
	)
}
