import type { Context, ExecutionContext } from 'hono'
import type { AppBindings } from '../config/env'
import type { GroupIndexAction } from '../services/groups.service'

// Фоновая векторная индексация группы через ai-воркер (Service Binding AI).
// Паттерн идентичен index-trigger.ts для заметок: c.executionCtx.waitUntil,
// клиент получает ответ сразу, ошибка уходит в wrangler tail.
export function triggerGroupVectorIndex(c: Context<AppBindings>, action: GroupIndexAction): void {
	const url =
		action.kind === 'upsert'
			? 'https://internal/internal/vectors/group-upsert'
			: 'https://internal/internal/vectors/group-delete'

	const body =
		action.kind === 'upsert'
			? { groupId: action.groupId, name: action.name, description: action.description }
			: { groupId: action.groupId }

	const promise = c.env.AI.fetch(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-user-id': action.userId,
		},
		body: JSON.stringify(body),
	})

	getExecutionCtx(c).waitUntil(promise)
}

function getExecutionCtx(c: Context<AppBindings>): ExecutionContext {
	return c.executionCtx
}
