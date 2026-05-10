import { drizzle } from 'drizzle-orm/d1'
import { and, eq, sql } from 'drizzle-orm'
import { groups, notes, type Group, type NewGroup } from './schema'

export async function insertGroup(db: D1Database, group: NewGroup): Promise<Group> {
	const rows = await drizzle(db).insert(groups).values(group).returning()
	return rows[0]!
}

export async function insertGroups(db: D1Database, values: NewGroup[]): Promise<Group[]> {
	return drizzle(db).insert(groups).values(values).returning()
}

export async function findGroupById(db: D1Database, id: string): Promise<Group | null> {
	const rows = await drizzle(db).select().from(groups).where(eq(groups.id, id)).limit(1)
	return rows[0] ?? null
}

export async function listGroupsByUser(db: D1Database, userId: string): Promise<Group[]> {
	return drizzle(db).select().from(groups).where(eq(groups.userId, userId))
}

export async function countGroupsByUser(db: D1Database, userId: string): Promise<number> {
	const rows = await drizzle(db)
		.select({ count: sql<number>`count(*)` })
		.from(groups)
		.where(eq(groups.userId, userId))
	return rows[0]?.count ?? 0
}

export interface GroupPatch {
	name?: string
	description?: string
	updatedAt: Date
}

export async function updateGroupFields(db: D1Database, id: string, patch: GroupPatch): Promise<Group> {
	const set: Partial<NewGroup> = { updatedAt: patch.updatedAt }
	if (patch.name !== undefined) set.name = patch.name
	if (patch.description !== undefined) set.description = patch.description
	const rows = await drizzle(db).update(groups).set(set).where(eq(groups.id, id)).returning()
	return rows[0]!
}

export async function deleteGroupById(db: D1Database, id: string): Promise<void> {
	await drizzle(db).delete(groups).where(eq(groups.id, id))
}

// Сбрасывает groupId у всех живых заметок пользователя перед удалением группы.
export async function clearGroupIdFromNotes(db: D1Database, userId: string, groupId: string): Promise<void> {
	await drizzle(db)
		.update(notes)
		.set({ groupId: null, updatedAt: new Date() })
		.where(and(eq(notes.userId, userId), eq(notes.groupId, groupId)))
}
