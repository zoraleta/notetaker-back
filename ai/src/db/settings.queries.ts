import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { settings, type Setting } from './schema'

// Тонкие обёртки над Drizzle для таблицы settings. Сервис не создаёт
// drizzle(db) сам (CLAUDE.md → правило 3 «DB только через db/»).

export async function getSetting(db: D1Database, key: string): Promise<Setting | null> {
	const rows = await drizzle(db).select().from(settings).where(eq(settings.key, key)).limit(1)
	return rows[0] ?? null
}

// Upsert: на одинаковый PK обновляем `value`/`updatedAt`. Без ON CONFLICT
// при гонке двух одновременных setSetting один из них вернёт UNIQUE-ошибку;
// для конфигурационной таблицы это маловероятно (правит один админ),
// но onConflictDoUpdate страхует от рейс-кейса при PUT с разных вкладок.
export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
	const now = new Date()
	await drizzle(db)
		.insert(settings)
		.values({ key, value, updatedAt: now })
		.onConflictDoUpdate({
			target: settings.key,
			set: { value, updatedAt: now },
		})
}
