import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

// Таблица пользователей. Email уникален, пароль хранится только в виде
// Scrypt-хеша (см. services/password.service.ts).
export const users = sqliteTable('users', {
	id: text('id').primaryKey(), // uuid v4
	email: text('email').notNull().unique(),
	passwordHash: text('password_hash').notNull(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
