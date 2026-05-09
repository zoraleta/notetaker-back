import type { Env } from '../config/env'
import {
	findNoteById,
	insertNote,
	listNotesByUser,
	softDeleteNote,
	updateNoteFields,
	type ListNotesFilters,
} from '../db/notes.queries'
import type { Note } from '../db/schema'
import { err, ok, type Result } from '../lib/result'

export interface CreateNoteInput {
	title?: string
	contentJson: unknown
	contentText: string
	projectId?: string | null
	tags?: string[]
}

export interface UpdateNoteInput {
	title?: string
	contentJson?: unknown
	contentText?: string
	projectId?: string | null
	tags?: string[]
}

export async function createNote(env: Env, userId: string, input: CreateNoteInput): Promise<Result<Note>> {
	const now = new Date()
	const note = await insertNote(env.DB, {
		id: crypto.randomUUID(),
		userId,
		title: input.title ?? '',
		contentJson: input.contentJson,
		contentText: input.contentText,
		projectId: input.projectId ?? null,
		tags: input.tags ?? [],
		createdAt: now,
		updatedAt: now,
	})
	return ok(note)
}

export async function listNotes(env: Env, userId: string, filters: ListNotesFilters): Promise<Result<Note[]>> {
	const list = await listNotesByUser(env.DB, userId, filters)
	return ok(list)
}

export async function getNote(env: Env, userId: string, id: string): Promise<Result<Note>> {
	return authoriseNote(env, id, userId)
}

export async function updateNote(
	env: Env,
	userId: string,
	id: string,
	input: UpdateNoteInput,
): Promise<Result<Note>> {
	const authResult = await authoriseNote(env, id, userId)
	if (!authResult.ok) return authResult

	const updated = await updateNoteFields(env.DB, id, { ...input, updatedAt: new Date() })
	return ok(updated)
}

export async function deleteNote(env: Env, userId: string, id: string): Promise<Result<void>> {
	const authResult = await authoriseNote(env, id, userId)
	if (!authResult.ok) return authResult

	await softDeleteNote(env.DB, id, new Date())
	return ok(undefined)
}

// Единая авторизация заметки. Различает «нет/удалена» (404) и «чужая» (403):
// фронт после регистрации/логина может перейти по прямой ссылке на чью-то
// заметку — 403 однозначно говорит «такой ресурс есть, но не твой», 404 —
// «не существует, не пытайся подбирать id». Tech-plan DoD это допускает.
async function authoriseNote(env: Env, id: string, userId: string): Promise<Result<Note>> {
	const note = await findNoteById(env.DB, id)
	if (!note || note.deletedAt !== null) {
		return err('Заметка не найдена', 'NOT_FOUND')
	}
	if (note.userId !== userId) {
		return err('Нет доступа к заметке', 'FORBIDDEN')
	}
	return ok(note)
}
