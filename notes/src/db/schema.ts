import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

// Таблица заметок. Все запросы фильтруются по user_id — индекс по нему
// обязателен. Soft-delete через deletedAt (не null = удалена); реальные
// строки в БД остаются, чтобы оставалась возможность восстановления.
//
// content_json — Tiptap JSON-документ как есть (mode: 'json' включает
// авто-сериализацию/парсинг через Drizzle). content_text — плоский текст,
// который фронт уже извлёк из Tiptap-документа (используется для
// эмбеддингов/поиска в Phase 5; на бэке не парсится).
//
// project_id и tags — denormalized: проекты появятся в Phase 7,
// внешний ключ не ставим (микросервисы → owner таблицы projects живёт
// в другом воркере, FK через границу D1-bindings всё равно не работает).
//
// is_indexed_at — отметка о последней успешной индексации в Vectorize
// (заполняется ai-воркером после upsert), на Phase 4 всегда null.
export const notes = sqliteTable(
	'notes',
	{
		id: text('id').primaryKey(), // uuid v4
		userId: text('user_id').notNull(),
		title: text('title').notNull().default(''),
		contentJson: text('content_json', { mode: 'json' }).$type<unknown>().notNull(),
		contentText: text('content_text').notNull(),
		projectId: text('project_id'),
		tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([] as never),
		isIndexedAt: integer('is_indexed_at', { mode: 'timestamp_ms' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
		deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
	},
	(table) => [index('notes_user_id_idx').on(table.userId)],
)

export type Note = typeof notes.$inferSelect
export type NewNote = typeof notes.$inferInsert
