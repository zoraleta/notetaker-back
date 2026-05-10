import { drizzle } from 'drizzle-orm/d1'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { notes, type NewNote, type Note } from './schema'

export interface ListNotesFilters {
	projectId?: string
	tag?: string
}

export async function insertNote(db: D1Database, note: NewNote): Promise<Note> {
	const rows = await drizzle(db).insert(notes).values(note).returning()
	// returning() гарантирует ровно одну строку при insert одного values.
	return rows[0]!
}

// Возвращает заметку по id без фильтра по userId/deletedAt — авторизация
// (404 если deletedAt, 403 если чужой userId) делается в сервисе, чтобы
// различать «нет заметки» и «есть, но не твоя».
export async function findNoteById(db: D1Database, id: string): Promise<Note | null> {
	const rows = await drizzle(db).select().from(notes).where(eq(notes.id, id)).limit(1)
	return rows[0] ?? null
}

export async function listNotesByUser(
	db: D1Database,
	userId: string,
	filters: ListNotesFilters,
): Promise<Note[]> {
	const conditions = [eq(notes.userId, userId), isNull(notes.deletedAt)]

	if (filters.projectId !== undefined) {
		conditions.push(eq(notes.projectId, filters.projectId))
	}

	// Фильтр по тегу через json_each: разворачивает JSON-массив tags
	// в виртуальные строки и матчит точное значение. Корректнее, чем LIKE
	// по сериализованному тексту (никаких false-positive по подстроке).
	if (filters.tag !== undefined) {
		conditions.push(
			sql`EXISTS (SELECT 1 FROM json_each(${notes.tags}) WHERE value = ${filters.tag})`,
		)
	}

	return drizzle(db).select().from(notes).where(and(...conditions)).orderBy(desc(notes.updatedAt))
}

// Поля, которые сервис может прислать на обновление. Все опциональны;
// undefined = не трогаем колонку, null (для projectId) = очистить.
export interface NotePatch {
	title?: string
	contentJson?: unknown
	contentText?: string
	projectId?: string | null
	tags?: string[]
	updatedAt: Date
}

export async function updateNoteFields(db: D1Database, id: string, patch: NotePatch): Promise<Note> {
	// Собираем только заданные поля — Drizzle на пустом set ругается,
	// но updatedAt всегда есть, так что set гарантированно не пустой.
	const set: Partial<NewNote> = { updatedAt: patch.updatedAt }
	if (patch.title !== undefined) set.title = patch.title
	if (patch.contentJson !== undefined) set.contentJson = patch.contentJson
	if (patch.contentText !== undefined) set.contentText = patch.contentText
	if (patch.projectId !== undefined) set.projectId = patch.projectId
	if (patch.tags !== undefined) set.tags = patch.tags

	const rows = await drizzle(db).update(notes).set(set).where(eq(notes.id, id)).returning()
	return rows[0]!
}

export async function softDeleteNote(db: D1Database, id: string, deletedAt: Date): Promise<void> {
	await drizzle(db)
		.update(notes)
		.set({ deletedAt, updatedAt: deletedAt })
		.where(eq(notes.id, id))
}

// Привязывает конкретные заметки пользователя к проекту.
// Фильтр по userId исключает случайную запись чужих заметок.
export async function batchLinkProject(
	db: D1Database,
	userId: string,
	noteIds: string[],
	projectId: string,
): Promise<void> {
	if (noteIds.length === 0) return
	await drizzle(db)
		.update(notes)
		.set({ projectId, updatedAt: new Date() })
		.where(and(eq(notes.userId, userId), inArray(notes.id, noteIds), isNull(notes.deletedAt)))
}

// Обнуляет projectId у всех живых заметок пользователя с данным projectId.
// Вызывается projects-воркером при удалении проекта.
export async function unlinkProjectFromNotes(
	db: D1Database,
	userId: string,
	projectId: string,
): Promise<void> {
	await drizzle(db)
		.update(notes)
		.set({ projectId: null, updatedAt: new Date() })
		.where(and(eq(notes.userId, userId), eq(notes.projectId, projectId), isNull(notes.deletedAt)))
}
