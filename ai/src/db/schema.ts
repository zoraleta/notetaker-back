import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

// AI-настройки. Гибрид «дефолт в коде → override в D1»: значения, которые
// пользователь может менять с фронта (`/settings/*` в Phase 5C), хранятся
// здесь; при отсутствии записи модули ai читают `DEFAULT_*` из
// `src/config/ai-models.ts` и `src/config/prompts.ts`.
//
// Зачем разделено на две таблицы:
// - `settings` — произвольные key/value (на старте только `active_model`,
//   но место для `embedding_model_lock` и др. оставлено).
// - `prompts` — строго override системных промптов (key из whitelist
//   `Object.keys(DEFAULT_PROMPTS)`; валидация в роуте Phase 5C).
//
// Обе таблицы — keyed by string, без userId: настройки глобальные на инстанс,
// не на пользователя (так задано в tech-plan §«Гибрид config + D1»).
//
// `value` хранится строкой; для сложных значений сериализуем JSON на уровне
// сервиса. SQLite позволил бы `mode: 'json'`, но для простых строк (id модели,
// текст промпта) это лишний parse/stringify на каждом чтении.
export const settings = sqliteTable('settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const prompts = sqliteTable('prompts', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export type Setting = typeof settings.$inferSelect
export type NewSetting = typeof settings.$inferInsert
export type PromptOverride = typeof prompts.$inferSelect
export type NewPromptOverride = typeof prompts.$inferInsert
