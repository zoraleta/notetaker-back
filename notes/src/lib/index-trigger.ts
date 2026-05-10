import type { Context, ExecutionContext } from 'hono'
import type { AppBindings } from '../config/env'
import type { IndexAction } from '../services/notes.service'

// Запускает фоновую индексацию заметки в Vectorize: по IndexAction строит
// запрос к ai-воркеру и оборачивает в c.executionCtx.waitUntil.
// Без `await` — Cloudflare runtime удерживает воркер живым до резолва
// (CLAUDE.md → правило 7 «Фоновая работа через c.executionCtx.waitUntil()»).
//
// userId передаётся заголовком x-user-id (единый стиль контракта между
// gateway/notes и ai — Phase 5 решение 6). Body — domain data (noteId,
// contentText, projectId или только noteId для delete).
//
// Если ai-воркер упадёт — CRUD заметки уже успешен, юзер ничего не теряет;
// ошибка фоновой задачи уйдёт в `wrangler tail`. Mass-reindex на проде
// будет отдельным admin-эндпоинтом, когда (если) понадобится.
export function triggerVectorIndex(c: Context<AppBindings>, action: IndexAction): void {
	const url = action.kind === 'upsert'
		? 'https://internal/internal/vectors/upsert'
		: 'https://internal/internal/vectors/delete'

	const body = action.kind === 'upsert'
		? { noteId: action.noteId, contentText: action.contentText }
		: { noteId: action.noteId }

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

// В типах Hono executionCtx помечен как опциональный — на практике в
// Workers он всегда есть, но компилятору это надо подсказать.
function getExecutionCtx(c: Context<AppBindings>): ExecutionContext {
	return c.executionCtx
}
