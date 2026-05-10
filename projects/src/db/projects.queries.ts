import { drizzle } from 'drizzle-orm/d1'
import { desc, eq } from 'drizzle-orm'
import { projects, type NewProject, type Project } from './schema'

export async function insertProject(db: D1Database, project: NewProject): Promise<Project> {
	const rows = await drizzle(db).insert(projects).values(project).returning()
	// returning() гарантирует ровно одну строку при insert одного values.
	return rows[0]!
}

// Возвращает проект без фильтра по userId — авторизация (403 если чужой,
// 404 если нет) делается в сервисе, чтобы различать «нет» и «не твой».
export async function findProjectById(db: D1Database, id: string): Promise<Project | null> {
	const rows = await drizzle(db).select().from(projects).where(eq(projects.id, id)).limit(1)
	return rows[0] ?? null
}

export async function listProjectsByUser(db: D1Database, userId: string): Promise<Project[]> {
	return drizzle(db)
		.select()
		.from(projects)
		.where(eq(projects.userId, userId))
		.orderBy(desc(projects.updatedAt))
}

export interface ProjectPatch {
	name?: string
	description?: string
	goal?: string | null
	stagesJson?: { title: string; done: boolean }[]
	openQuestionsJson?: string[]
	updatedAt: Date
}

export async function updateProjectFields(db: D1Database, id: string, patch: ProjectPatch): Promise<Project> {
	const set: Partial<NewProject> = { updatedAt: patch.updatedAt }
	if (patch.name !== undefined) set.name = patch.name
	if (patch.description !== undefined) set.description = patch.description
	if (patch.goal !== undefined) set.goal = patch.goal
	if (patch.stagesJson !== undefined) set.stagesJson = patch.stagesJson
	if (patch.openQuestionsJson !== undefined) set.openQuestionsJson = patch.openQuestionsJson

	const rows = await drizzle(db).update(projects).set(set).where(eq(projects.id, id)).returning()
	// Сервис вызывает authorizeProject перед update, поэтому строка гарантированно существует.
	return rows[0]!
}

export async function deleteProjectById(db: D1Database, id: string): Promise<void> {
	await drizzle(db).delete(projects).where(eq(projects.id, id))
}
