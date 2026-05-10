import type { Env } from '../config/env'
import { embedText } from './embedding.service'
import { queryGroupVectors, type GroupVectorMetadata } from '../db/vectors.queries'

// Минимальный cosine similarity для предложения группы.
// bge-m3: «по теме» начинается с ~0.45, «слабо» — 0.3-0.45.
const MIN_GROUP_SCORE = 0.3

export interface GroupSuggestion {
	groupId: string
	score: number
}

export interface GroupSuggestResult {
	suggestions: GroupSuggestion[]
	emptyGroupIds: string[]
}

// Предлагает топ-K групп для переданного текста заметки.
// Работает даже если в группах нет ни одной заметки — векторы групп
// хранятся по name+description, не по контенту.
// Дополнительно возвращает ID групп без единой заметки — для подсказки
// «начни использовать эту группу».
export async function suggestGroups(
	env: Env,
	userId: string,
	noteText: string,
	topK: number,
): Promise<GroupSuggestResult> {
	const [values, emptyGroupIds] = await Promise.all([
		embedText(env, noteText),
		fetchEmptyGroupIds(env.DB, userId),
	])

	const result = await queryGroupVectors(env.VECTORIZE, values, { userId, topK })

	const suggestions = result.matches
		.filter((match) => match.score >= MIN_GROUP_SCORE)
		.map((match) => {
			const metadata = match.metadata as GroupVectorMetadata | undefined
			if (!metadata || typeof metadata.groupId !== 'string') return null
			return { groupId: metadata.groupId, score: match.score }
		})
		.filter((hit): hit is GroupSuggestion => hit !== null)

	return { suggestions, emptyGroupIds }
}

// Возвращает ID групп пользователя, к которым не прикреплено ни одной
// активной (не удалённой) заметки. Использует raw D1 — groups/notes не
// входят в Drizzle-схему ai-воркера, добавлять их только ради этого запроса
// было бы over-engineering.
async function fetchEmptyGroupIds(db: D1Database, userId: string): Promise<string[]> {
	const result = await db
		.prepare(
			`SELECT g.id FROM groups g
       WHERE g.user_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM notes n
           WHERE n.user_id = ? AND n.group_id = g.id AND n.deleted_at IS NULL
         )`,
		)
		.bind(userId, userId)
		.all<{ id: string }>()
	return result.results.map((r) => r.id)
}
