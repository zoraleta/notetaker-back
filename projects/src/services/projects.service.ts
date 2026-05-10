import type { Env } from '../config/env'
import {
	deleteProjectById,
	findProjectById,
	insertProject,
	listProjectsByUser,
	updateProjectFields,
} from '../db/projects.queries'
import type { Project } from '../db/schema'
import { err, ok, type Result } from '../lib/result'

const NOTES_LINK_URL = 'https://internal/internal/notes/link-project'
const NOTES_UNLINK_URL = 'https://internal/internal/notes/unlink-project'

export interface CreateProjectInput {
	name: string
	description?: string
}

export interface FromPackInput {
	name: string
	description?: string
	pack: {
		goal?: string
		stages?: { title: string; done: boolean }[]
		openQuestions?: string[]
	}
	sourceNoteIds: string[]
}

export interface UpdateProjectInput {
	name?: string
	description?: string
	goal?: string | null
	stages?: { title: string; done: boolean }[]
	openQuestions?: string[]
}

export async function createProject(env: Env, userId: string, input: CreateProjectInput): Promise<Result<Project>> {
	const now = new Date()
	const project = await insertProject(env.DB, {
		id: crypto.randomUUID(),
		userId,
		name: input.name,
		description: input.description ?? '',
		createdAt: now,
		updatedAt: now,
	})
	return ok(project)
}

export async function fromPackProject(env: Env, userId: string, input: FromPackInput): Promise<Result<Project>> {
	const now = new Date()
	const project = await insertProject(env.DB, {
		id: crypto.randomUUID(),
		userId,
		name: input.name,
		description: input.description ?? '',
		goal: input.pack.goal ?? null,
		stagesJson: input.pack.stages ?? null,
		openQuestionsJson: input.pack.openQuestions ?? null,
		createdAt: now,
		updatedAt: now,
	})

	if (input.sourceNoteIds.length > 0) {
		const linkResult = await callNotesLinkProject(env, userId, input.sourceNoteIds, project.id)
		if (!linkResult.ok) {
			// Компенсирующий откат: проект создан, но привязка заметок не удалась —
			// удаляем проект, чтобы не оставлять «мусорную» запись.
			await deleteProjectById(env.DB, project.id)
			return linkResult
		}
	}

	return ok(project)
}

export async function listProjects(env: Env, userId: string): Promise<Result<Project[]>> {
	const list = await listProjectsByUser(env.DB, userId)
	return ok(list)
}

export async function getProject(env: Env, userId: string, id: string): Promise<Result<Project>> {
	return authorizeProject(env, id, userId)
}

export async function updateProject(
	env: Env,
	userId: string,
	id: string,
	input: UpdateProjectInput,
): Promise<Result<Project>> {
	const authResult = await authorizeProject(env, id, userId)
	if (!authResult.ok) return authResult

	const updated = await updateProjectFields(env.DB, id, {
		name: input.name,
		description: input.description,
		goal: input.goal,
		stagesJson: input.stages,
		openQuestionsJson: input.openQuestions,
		updatedAt: new Date(),
	})
	return ok(updated)
}

export async function deleteProject(env: Env, userId: string, id: string): Promise<Result<void>> {
	const authResult = await authorizeProject(env, id, userId)
	if (!authResult.ok) return authResult

	const unlinkResult = await callNotesUnlinkProject(env, userId, id)
	if (!unlinkResult.ok) return unlinkResult

	await deleteProjectById(env.DB, id)
	return ok(undefined)
}

async function authorizeProject(env: Env, id: string, userId: string): Promise<Result<Project>> {
	const project = await findProjectById(env.DB, id)
	if (!project) {
		return err('Проект не найден', 'NOT_FOUND')
	}
	if (project.userId !== userId) {
		return err('Нет доступа к проекту', 'FORBIDDEN')
	}
	return ok(project)
}

// Вызывает внутренний эндпоинт notes-воркера для привязки заметок к проекту.
// Caller (projects-воркер) гарантирует, что projectId принадлежит userId.
async function callNotesLinkProject(
	env: Env,
	userId: string,
	noteIds: string[],
	projectId: string,
): Promise<Result<void>> {
	const res = await env.NOTES.fetch(NOTES_LINK_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-user-id': userId },
		body: JSON.stringify({ noteIds, projectId }),
	})
	if (!res.ok) {
		return err('Ошибка привязки заметок к проекту', 'EXTERNAL')
	}
	return ok(undefined)
}

// Вызывает внутренний эндпоинт notes-воркера для обнуления projectId у всех
// заметок, принадлежащих данному проекту.
async function callNotesUnlinkProject(
	env: Env,
	userId: string,
	projectId: string,
): Promise<Result<void>> {
	const res = await env.NOTES.fetch(NOTES_UNLINK_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-user-id': userId },
		body: JSON.stringify({ projectId }),
	})
	if (!res.ok) {
		return err('Ошибка отвязки заметок от проекта', 'EXTERNAL')
	}
	return ok(undefined)
}
