// Whitelist моделей Workers AI, разрешённых для chat/instruction-задач
// (summarize, classify, discuss, pack-into-project). Расширяется только
// явным редактированием кода — фронт не может через `/settings/active-model`
// записать произвольный id.
//
// Список держим коротким: 8b — для скорости, 70b — когда нужно качество.
// Cloudflare периодически добавляет/выводит модели; при изменении этого
// списка проверь актуальность в дашборде Workers AI.
export const ALLOWED_MODELS = [
	'@cf/meta/llama-3.1-8b-instruct',
	'@cf/meta/llama-3.3-70b-instruct-fp8-fast',
] as const

export type AllowedModel = (typeof ALLOWED_MODELS)[number]

export const DEFAULT_MODEL: AllowedModel = '@cf/meta/llama-3.1-8b-instruct'

// Embedding-модель — отдельная константа, через UI не меняется.
// Причина: смена модели = смена dimensions = новый Vectorize-индекс
// (CLAUDE.md → «Векторный индекс»). Пока bge-m3 устраивает (multilingual,
// поддерживает русский, 1024-мерный).
export const EMBEDDING_MODEL = '@cf/baai/bge-m3' as const
export const EMBEDDING_DIMENSIONS = 1024
