import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

export const projects = sqliteTable(
	'projects',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull(),
		name: text('name').notNull(),
		description: text('description').notNull().default(''),
		goal: text('goal'),
		stagesJson: text('stages_json', { mode: 'json' }).$type<{ title: string; done: boolean }[]>(),
		openQuestionsJson: text('open_questions_json', { mode: 'json' }).$type<string[]>(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(table) => [index('projects_user_id_idx').on(table.userId)],
)

export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
