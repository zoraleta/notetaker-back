import type { Env } from '../config/env'
import { embedText } from './embedding.service'
import { NO_PROJECT, queryNoteVectors, type NoteVectorMetadata } from '../db/vectors.queries'

// Auto-классификация заметки по соседям в Vectorize (F3, Phase 5E).
// Идея: близкие заметки уже разнесены пользователем по проектам, поэтому
// «голосование» по топ-K соседей даёт suggestion `projectId | null` без
// отдельного хранилища центроидов проектов (tech-plan §5.5).
//
// Анти-шум: per-neighbor min-score filter (MIN_NEIGHBOR_SCORE). На bge-m3
// для русских коротких текстов «не связано» даёт ~0.20-0.35, «слабо
// связано» ~0.35-0.45, «по теме» 0.45+. Без фильтра рецепт-запрос на
// DB из 5 IT-заметок набирал sum=1.5+ (5 слабых соседей по ~0.3) и
// ложно классифицировался — фильтр отсекает первые два класса до
// агрегации.
//
// NO_PROJECT-соседи в голосовании не участвуют — иначе любой текст
// случайно «голосовал» бы за мажоритарный класс «без проекта».

const CLASSIFY_TOPK = 20
const MIN_NEIGHBOR_SCORE = 0.45
const SCORE_THRESHOLD = 0.75

export interface ClassifyResult {
	projectId: string | null
	score: number | null
}

export async function classifyNote(
	env: Env,
	userId: string,
	contentText: string,
): Promise<ClassifyResult> {
	const values = await embedText(env, contentText)
	const result = await queryNoteVectors(env.VECTORIZE, values, { userId, topK: CLASSIFY_TOPK })

	const sumByProject = new Map<string, number>()
	for (const match of result.matches) {
		if (match.score < MIN_NEIGHBOR_SCORE) continue
		const metadata = match.metadata as NoteVectorMetadata | undefined
		if (!metadata || typeof metadata.projectId !== 'string') continue
		if (metadata.projectId === NO_PROJECT) continue
		const prev = sumByProject.get(metadata.projectId) ?? 0
		sumByProject.set(metadata.projectId, prev + match.score)
	}

	let bestProjectId: string | null = null
	let bestScore = 0
	for (const [projectId, sum] of sumByProject) {
		if (sum > bestScore) {
			bestScore = sum
			bestProjectId = projectId
		}
	}

	if (bestProjectId !== null && bestScore > SCORE_THRESHOLD) {
		return { projectId: bestProjectId, score: bestScore }
	}
	return { projectId: null, score: null }
}
