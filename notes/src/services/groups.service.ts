import type { Env } from '../config/env'
import { DEFAULT_GROUPS } from '../config/default-groups'
import {
	clearGroupIdFromNotes,
	countGroupsByUser,
	deleteGroupById,
	findGroupById,
	insertGroups,
	insertGroup,
	listGroupsByUser,
	updateGroupFields,
} from '../db/groups.queries'
import type { Group } from '../db/schema'
import { err, ok, type Result } from '../lib/result'

export type GroupIndexAction =
	| { kind: 'upsert'; userId: string; groupId: string; name: string; description: string }
	| { kind: 'delete'; userId: string; groupId: string }

export interface GroupMutationResult {
	group: Group
	index: GroupIndexAction
}

export interface ListGroupsResult {
	groups: Group[]
	toIndex: GroupIndexAction[]
}

export interface CreateGroupInput {
	name: string
	description?: string
}

export interface UpdateGroupInput {
	name?: string
	description?: string
}

// Возвращает группы пользователя. Если групп ещё нет — сидирует дефолтные
// и возвращает их вместе с toIndex-действиями для фоновой векторной индексации.
export async function listGroups(env: Env, userId: string): Promise<Result<ListGroupsResult>> {
	const count = await countGroupsByUser(env.DB, userId)
	if (count > 0) {
		const groups = await listGroupsByUser(env.DB, userId)
		return ok({ groups, toIndex: [] })
	}

	const now = new Date()
	const newGroups = await insertGroups(
		env.DB,
		DEFAULT_GROUPS.map((def) => ({
			id: crypto.randomUUID(),
			userId,
			name: def.name,
			description: def.description,
			isDefault: true,
			createdAt: now,
			updatedAt: now,
		})),
	)

	const toIndex: GroupIndexAction[] = newGroups.map((g) => ({
		kind: 'upsert',
		userId,
		groupId: g.id,
		name: g.name,
		description: g.description,
	}))

	return ok({ groups: newGroups, toIndex })
}

export async function createGroup(
	env: Env,
	userId: string,
	input: CreateGroupInput,
): Promise<Result<GroupMutationResult>> {
	const now = new Date()
	const group = await insertGroup(env.DB, {
		id: crypto.randomUUID(),
		userId,
		name: input.name,
		description: input.description ?? '',
		isDefault: false,
		createdAt: now,
		updatedAt: now,
	})
	return ok({ group, index: upsertActionFor(group) })
}

export async function updateGroup(
	env: Env,
	userId: string,
	id: string,
	input: UpdateGroupInput,
): Promise<Result<GroupMutationResult>> {
	const authResult = await authoriseGroup(env, id, userId)
	if (!authResult.ok) return authResult

	const updated = await updateGroupFields(env.DB, id, { ...input, updatedAt: new Date() })
	return ok({ group: updated, index: upsertActionFor(updated) })
}

export async function deleteGroup(
	env: Env,
	userId: string,
	id: string,
): Promise<Result<{ index: GroupIndexAction }>> {
	const authResult = await authoriseGroup(env, id, userId)
	if (!authResult.ok) return authResult

	await clearGroupIdFromNotes(env.DB, userId, id)
	await deleteGroupById(env.DB, id)
	return ok({ index: { kind: 'delete', userId, groupId: id } })
}

async function authoriseGroup(env: Env, id: string, userId: string): Promise<Result<Group>> {
	const group = await findGroupById(env.DB, id)
	if (!group) return err('Группа не найдена', 'NOT_FOUND')
	if (group.userId !== userId) return err('Нет доступа к группе', 'FORBIDDEN')
	return ok(group)
}

function upsertActionFor(group: Group): GroupIndexAction {
	return {
		kind: 'upsert',
		userId: group.userId,
		groupId: group.id,
		name: group.name,
		description: group.description,
	}
}
