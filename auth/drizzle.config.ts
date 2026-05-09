import type { Config } from 'drizzle-kit'

// Конфиг drizzle-kit — генерирует SQL-миграции в ./drizzle
// из схемы ./src/db/schema.ts. Сами миграции применяет wrangler
// (`npm run db:apply:local` / `db:apply:prod`).
export default {
	schema: './src/db/schema.ts',
	out: './drizzle',
	dialect: 'sqlite',
} satisfies Config
