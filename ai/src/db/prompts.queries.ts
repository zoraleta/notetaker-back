import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { prompts, type PromptOverride } from './schema'

// Обёртки над Drizzle для таблицы prompts (override системных промптов).
// Whitelist ключей валидируется на роуте через Zod (Phase 5C);
// в queries — никаких проверок, доверяем входящему key.

export async function getPromptOverride(db: D1Database, key: string): Promise<PromptOverride | null> {
	const rows = await drizzle(db).select().from(prompts).where(eq(prompts.key, key)).limit(1)
	return rows[0] ?? null
}

// Все override'ы разом — для GET /settings (Phase 5C). Без фильтра по ключу:
// whitelist у нас 4 строки, лишние записи (от старых релизов) сервис всё равно
// игнорирует — мы джойним только по `Object.keys(DEFAULT_PROMPTS)`.
export async function listPromptOverrides(db: D1Database): Promise<PromptOverride[]> {
	return drizzle(db).select().from(prompts)
}

// db-слой описывает физическую операцию (upsert / remove строки), сервис —
// доменную (set / delete override'а). Имена развели, чтобы не плодить
// `as Row`-алиасы на импортах.
export async function upsertPromptOverride(db: D1Database, key: string, value: string): Promise<void> {
	const now = new Date()
	await drizzle(db)
		.insert(prompts)
		.values({ key, value, updatedAt: now })
		.onConflictDoUpdate({
			target: prompts.key,
			set: { value, updatedAt: now },
		})
}

// DELETE без RETURNING: удаляем запись и не сообщаем, существовала ли она —
// сервис в Phase 5C всё равно вернёт 204 (идемпотентно). Если ничего не удалили,
// `getPromptOverride` после вернёт `null`, и `getPrompt` отдаст дефолт.
export async function removePromptOverride(db: D1Database, key: string): Promise<void> {
	await drizzle(db).delete(prompts).where(eq(prompts.key, key))
}
