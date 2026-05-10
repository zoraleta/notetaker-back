import type { Env } from '../config/env'
import { embedText } from './embedding.service'
import { deleteNoteVectorById, upsertNoteVector, upsertGroupVector, deleteGroupVectorById } from '../db/vectors.queries'

// Сервис индексации заметок в Vectorize. HTTP-agnostic: принимает env
// и примитивы, возвращает Promise<void>. Ожидаемых ошибок нет (не нашли
// заметку и т.п. — это уровень notes-воркера, сюда вызовы приходят уже
// «доверенными»). Если эмбеддинг или Vectorize.upsert падают — это
// неожиданная ошибка, поднимается в onError → 500.

export interface UpsertNoteVectorInput {
	noteId: string
	userId: string
	contentText: string
	projectId: string | null
}

export async function upsertNote(env: Env, input: UpsertNoteVectorInput): Promise<void> {
	const values = await embedText(env, input.contentText)
	await upsertNoteVector(env.VECTORIZE, {
		noteId: input.noteId,
		userId: input.userId,
		values,
		projectId: input.projectId,
	})
}

export async function deleteNote(env: Env, noteId: string): Promise<void> {
	await deleteNoteVectorById(env.VECTORIZE, noteId)
}

export interface UpsertGroupVectorInput {
	groupId: string
	userId: string
	name: string
	description: string
}

export async function upsertGroup(env: Env, input: UpsertGroupVectorInput): Promise<void> {
	const text = input.description ? `${input.name}. ${input.description}` : input.name
	const values = await embedText(env, text)
	await upsertGroupVector(env.VECTORIZE, { groupId: input.groupId, userId: input.userId, values })
}

export async function deleteGroup(env: Env, groupId: string): Promise<void> {
	await deleteGroupVectorById(env.VECTORIZE, groupId)
}
