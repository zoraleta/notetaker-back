import type { Env } from '../config/env'

// Доступ к данным заметок через SVC binding `NOTES` (Phase 5F). Аналогично
// `vectors.queries.ts` — это «внешний источник данных», который сервис
// использует через узкий контракт. Транспорт (URL, заголовки, парсинг JSON,
// soft-fail) живёт здесь, чтобы develop.service занимался только алгоритмом.
//
// Контракт идентичен фронтовому `GET /notes`: notes-воркер не делает
// различий между клиентами (CLAUDE.md → SVC bindings, правило 8). Заголовок
// `x-user-id` пробрасываем явно — gateway этим занят только для frontend'а.

export interface NotesListItem {
	id: string
	contentText: string
	updatedAt: string
	projectId: string | null
}

// Безопасное чтение списка заметок. Любая поломка (5xx от notes, упавший
// JSON, дрейф shape ответа) → `[]`. Это соответствует soft-fail-семантике
// F4 (см. develop.service): дашборд не должен падать из-за одного блока.
export async function fetchUserNotes(env: Env, userId: string): Promise<NotesListItem[]> {
	const response = await env.NOTES.fetch('https://internal/notes', {
		headers: { 'x-user-id': userId },
	})
	if (!response.ok) return []
	try {
		const data = (await response.json()) as unknown
		if (!Array.isArray(data)) return []
		// Минимальная проверка формы — не Zod, чтобы не тащить схему ради
		// одного места. Если notes когда-нибудь изменит формат, тест
		// разоблачит мгновенно (DoD smoke F4 = 0 кандидатов).
		return data.filter(
			(item): item is NotesListItem =>
				typeof item === 'object' &&
				item !== null &&
				typeof (item as { id?: unknown }).id === 'string' &&
				typeof (item as { contentText?: unknown }).contentText === 'string',
		)
	} catch {
		return []
	}
}

// Минимальные данные заметки для «похожих» — только id и title.
// Soft-fail: недоступный notes-воркер или 404 → null, caller фильтрует.
export async function fetchNoteSummary(
	env: Env,
	userId: string,
	noteId: string,
): Promise<{ id: string; title: string } | null> {
	try {
		const response = await env.NOTES.fetch(`https://internal/notes/${noteId}`, {
			headers: { 'x-user-id': userId },
		})
		if (!response.ok) return null
		const data = (await response.json()) as unknown
		if (typeof data !== 'object' || data === null) return null
		const d = data as { id?: unknown; title?: unknown }
		if (typeof d.id !== 'string' || typeof d.title !== 'string') return null
		return { id: d.id, title: d.title }
	} catch {
		return null
	}
}

// Soft-fail семантика для RAG (Phase 5G): если k из N соседей упали (404 от
// soft-delete между queryById и fetch, упавший notes-воркер, дрейф shape),
// `/discuss` отдаёт ответ с RAG-подмножеством из (N-k) удачных, а не 502.
// Поэтому возвращаем `string | null`, а не throw'аем — caller их фильтрует.
export async function fetchNoteContentText(
	env: Env,
	userId: string,
	noteId: string,
): Promise<string | null> {
	try {
		const response = await env.NOTES.fetch(`https://internal/notes/${noteId}`, {
			headers: { 'x-user-id': userId },
		})
		if (!response.ok) return null
		const data = (await response.json()) as unknown
		if (typeof data !== 'object' || data === null) return null
		const text = (data as { contentText?: unknown }).contentText
		return typeof text === 'string' ? text : null
	} catch {
		return null
	}
}
