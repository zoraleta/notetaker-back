// Тонкие обёртки над Cloudflare Vectorize. Хранилище как «db» — отсюда
// и расположение в `db/`, хотя физически это не SQLite (CLAUDE.md →
// «Векторный индекс»). НЕ создавать generic BaseVectorRepository:
// нативный API из 4 методов короткий, обёртки оставляем плоскими.
//
// Принципы:
// - id вектора заметки — детерминированный: `note:<uuid>`. Это даёт
//   идемпотентный upsert (повторный вызов обновит вектор, не создаст дубль)
//   и предсказуемое имя для deleteByIds / queryById.
// - namespace = userId — изоляция данных пользователей через индексную
//   структуру Vectorize, не через фильтр (CLAUDE.md «Векторный индекс»).
// - filter: { userId } — дублирующий guard в дополнение к namespace
//   на случай ошибки в namespace.
// - returnMetadata: 'all' — нам нужны projectId/noteId/userId в ответе,
//   чтобы service-слой мог вернуть их клиенту.
// - projectId хранится как строка '' (а не null), потому что
//   VectorizeVectorMetadataValue = string|number|boolean|string[] не разрешает
//   null. На стороне service '' трактуем как «без проекта».

const NOTE_ID_PREFIX = 'note:'
const GROUP_ID_PREFIX = 'group:'
export const NO_PROJECT = ''

export const vectorIdForNote = (noteId: string): string => `${NOTE_ID_PREFIX}${noteId}`
export const vectorIdForGroup = (groupId: string): string => `${GROUP_ID_PREFIX}${groupId}`

// Декларативный «контракт» на форму metadata, которую кладём в Vectorize.
// Отдельный тип удобен в search.service для типизированного приведения
// после `returnMetadata: 'all'`.
export interface NoteVectorMetadata {
	userId: string
	noteId: string
	projectId: string // '' если заметка не привязана к проекту
	type: 'note'
	updatedAt: number
}

export interface GroupVectorMetadata {
	userId: string
	groupId: string
	type: 'group'
	updatedAt: number
}

export interface UpsertGroupVectorArgs {
	groupId: string
	userId: string
	values: number[]
}

export async function upsertGroupVector(index: Vectorize, args: UpsertGroupVectorArgs): Promise<void> {
	const metadata: Record<string, VectorizeVectorMetadata> = {
		userId: args.userId,
		groupId: args.groupId,
		type: 'group',
		updatedAt: Date.now(),
	}
	await index.upsert([
		{
			id: vectorIdForGroup(args.groupId),
			namespace: args.userId,
			values: args.values,
			metadata,
		},
	])
}

export async function deleteGroupVectorById(index: Vectorize, groupId: string): Promise<void> {
	await index.deleteByIds([vectorIdForGroup(groupId)])
}

export interface GroupQueryOptions {
	userId: string
	topK: number
}

export async function queryGroupVectors(
	index: Vectorize,
	values: number[],
	options: GroupQueryOptions,
): Promise<VectorizeMatches> {
	return index.query(values, {
		namespace: options.userId,
		topK: options.topK,
		filter: { userId: options.userId, type: 'group' },
		returnMetadata: 'all',
	})
}

export interface UpsertNoteVectorArgs {
	noteId: string
	userId: string
	values: number[]
	projectId: string | null
}

export async function upsertNoteVector(index: Vectorize, args: UpsertNoteVectorArgs): Promise<void> {
	// metadata типизируем как Record<string, VectorizeVectorMetadata> (требование SDK),
	// а форма нашей записи описана отдельным типом NoteVectorMetadata —
	// он используется при чтении в search.service для приведения после
	// `returnMetadata: 'all'`.
	const metadata: Record<string, VectorizeVectorMetadata> = {
		userId: args.userId,
		noteId: args.noteId,
		projectId: args.projectId ?? NO_PROJECT,
		type: 'note',
		updatedAt: Date.now(),
	}
	await index.upsert([
		{
			id: vectorIdForNote(args.noteId),
			namespace: args.userId,
			values: args.values,
			metadata,
		},
	])
}

export async function deleteNoteVectorById(index: Vectorize, noteId: string): Promise<void> {
	await index.deleteByIds([vectorIdForNote(noteId)])
}

export interface NoteQueryOptions {
	userId: string
	topK: number
}

// Семантический поиск по эмбеддингу запроса. namespace + filter — двойной guard.
export async function queryNoteVectors(
	index: Vectorize,
	values: number[],
	options: NoteQueryOptions,
): Promise<VectorizeMatches> {
	return index.query(values, {
		namespace: options.userId,
		topK: options.topK,
		filter: { userId: options.userId, type: 'note' },
		returnMetadata: 'all',
	})
}

// Поиск по уже существующему вектору заметки (для «Похожие»). Если вектора
// для noteId нет в индексе (заметка только что создана, индексация в фоне) —
// Vectorize возвращает пустой `matches`, не ошибку.
export async function queryNoteVectorsById(
	index: Vectorize,
	noteId: string,
	options: NoteQueryOptions,
): Promise<VectorizeMatches> {
	return index.queryById(vectorIdForNote(noteId), {
		namespace: options.userId,
		topK: options.topK,
		filter: { userId: options.userId, type: 'note' },
		returnMetadata: 'all',
	})
}

// Общий разбор результата `queryNoteVectorsById` для сценариев «соседи
// этой заметки» (5F develop, 5G discuss). Скип self (тот же noteId всегда
// в топе с score=1) и валидация формы metadata — две одинаковые проверки,
// которые сервисам нужны до их собственного решения по score-filter'у.
export interface NeighborMatch {
	noteId: string
	score: number
}

export function extractNeighborMatches(
	matches: VectorizeMatches,
	selfNoteId: string,
	limit: number,
): NeighborMatch[] {
	const selfId = vectorIdForNote(selfNoteId)
	const result: NeighborMatch[] = []
	for (const match of matches.matches) {
		if (match.id === selfId) continue
		const metadata = match.metadata as NoteVectorMetadata | undefined
		if (!metadata || typeof metadata.noteId !== 'string') continue
		result.push({ noteId: metadata.noteId, score: match.score })
		if (result.length >= limit) break
	}
	return result
}
