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

// Предлагает топ-K групп для переданного текста заметки.
// Работает даже если в группах нет ни одной заметки — векторы групп
// хранятся по name+description, не по контенту.
export async function suggestGroups(
	env: Env,
	userId: string,
	noteText: string,
	topK: number,
): Promise<GroupSuggestion[]> {
	const values = await embedText(env, noteText)
	const result = await queryGroupVectors(env.VECTORIZE, values, { userId, topK })

	return result.matches
		.filter((match) => match.score >= MIN_GROUP_SCORE)
		.map((match) => {
			const metadata = match.metadata as GroupVectorMetadata | undefined
			if (!metadata || typeof metadata.groupId !== 'string') return null
			return { groupId: metadata.groupId, score: match.score }
		})
		.filter((hit): hit is GroupSuggestion => hit !== null)
}
