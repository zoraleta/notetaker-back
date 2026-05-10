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
	groupId?: string | null
	tags?: string[]
}

export interface UpdateNoteInput {
	title?: string
	contentJson?: unknown
	contentText?: string
	groupId?: string | null
	tags?: string[]
}

// Действие, которое роут должен запустить через c.executionCtx.waitUntil
// после успешного CRUD заметки. Сервис остаётся HTTP-agnostic (CLAUDE.md →
// правило 2): не принимает ExecutionContext, не зовёт env.AI.fetch сам.
// Discriminated union вместо двух отдельных полей — фиксирует, что upsert
// и delete взаимоисключающие.
export type IndexAction =
	| { kind: 'upsert'; userId: string; noteId: string; contentText: string }
	| { kind: 'delete'; userId: string; noteId: string }

// CRUD-операции возвращают и заметку (для ответа клиенту), и IndexAction
// (для роутового waitUntil). Удаление возвращает только action — самой
// строки в ответе нет (204).
export interface NoteMutationResult {
	note: Note
	index: IndexAction
}

export interface DeleteMutationResult {
	index: IndexAction
}

export async function createNote(env: Env, userId: string, input: CreateNoteInput): Promise<Result<NoteMutationResult>> {
	const now = new Date()
	const note = await insertNote(env.DB, {
		id: crypto.randomUUID(),
		userId,
		title: input.title ?? '',
		contentJson: input.contentJson,
		contentText: input.contentText,
		groupId: input.groupId ?? null,
		tags: input.tags ?? [],
		createdAt: now,
		updatedAt: now,
	})
	return ok({ note, index: upsertActionFor(note) })
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
): Promise<Result<NoteMutationResult>> {
	const authResult = await authoriseNote(env, id, userId)
	if (!authResult.ok) return authResult

	const updated = await updateNoteFields(env.DB, id, { ...input, updatedAt: new Date() })
	return ok({ note: updated, index: upsertActionFor(updated) })
}

export async function deleteNote(env: Env, userId: string, id: string): Promise<Result<DeleteMutationResult>> {
	const authResult = await authoriseNote(env, id, userId)
	if (!authResult.ok) return authResult

	await softDeleteNote(env.DB, id, new Date())
	return ok({
		index: { kind: 'delete', userId, noteId: id },
	})
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

function upsertActionFor(note: Note): IndexAction {
	return {
		kind: 'upsert',
		userId: note.userId,
		noteId: note.id,
		contentText: note.contentText,
	}
}
