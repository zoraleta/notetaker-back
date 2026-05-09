import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { users, type NewUser, type User } from './schema'

export async function findUserByEmail(db: D1Database, email: string): Promise<User | null> {
	const rows = await drizzle(db).select().from(users).where(eq(users.email, email)).limit(1)
	return rows[0] ?? null
}

// Возвращает true, если строка вставлена, и false — если email уже занят
// (UNIQUE-конфликт). Атомарность важна: между findUserByEmail и insertUser
// возможна гонка двух регистраций, ON CONFLICT DO NOTHING её закрывает.
export async function insertUserIfFree(db: D1Database, user: NewUser): Promise<boolean> {
	const inserted = await drizzle(db)
		.insert(users)
		.values(user)
		.onConflictDoNothing({ target: users.email })
		.returning({ id: users.id })
	return inserted.length > 0
}
