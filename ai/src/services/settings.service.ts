import type { Env } from '../config/env'
import {
	ALLOWED_MODELS,
	DEFAULT_MODEL,
	EMBEDDING_DIMENSIONS,
	EMBEDDING_MODEL,
	type AllowedModel,
} from '../config/ai-models'
import { DEFAULT_PROMPTS, type PromptKey } from '../config/prompts'
import { getSetting, setSetting } from '../db/settings.queries'
import {
	getPromptOverride,
	listPromptOverrides,
	removePromptOverride,
	upsertPromptOverride,
} from '../db/prompts.queries'

// Гибридное чтение настроек: D1 → fallback на дефолты в коде.
// Используется всеми AI-сервисами Phase 5 (summarize, classify, discuss, pack).
// CRUD-обёртки ниже — для роутов `/settings/*` (Phase 5C).

const ACTIVE_MODEL_KEY = 'active_model'

// Snapshot всей AI-конфигурации для GET /settings. Для каждого known-промпта
// показываем default из кода, override из D1 (если есть) и effective (что
// реально пойдёт в LLM). Это чистая «view-модель» — фронт получает всё
// необходимое одним запросом, без N round-trip'ов на каждый промпт.
export interface PromptView {
	default: string
	override: string | null
	effective: string
}

export interface SettingsView {
	activeModel: AllowedModel
	allowedModels: readonly AllowedModel[]
	embeddingModel: typeof EMBEDDING_MODEL
	embeddingDimensions: typeof EMBEDDING_DIMENSIONS
	prompts: Record<PromptKey, PromptView>
}

// Возвращает активную chat-модель: запись в settings.active_model, если есть
// и валидна по whitelist; иначе DEFAULT_MODEL. Whitelist-проверка дублирует
// Zod на роуте (Phase 5C) — на случай, если в БД попало значение из старой
// версии whitelist'а после редеплоя.
export async function getActiveModel(env: Env): Promise<AllowedModel> {
	const saved = await getSetting(env.DB, ACTIVE_MODEL_KEY)
	if (saved && (ALLOWED_MODELS as readonly string[]).includes(saved.value)) {
		return saved.value as AllowedModel
	}
	return DEFAULT_MODEL
}

// Возвращает текст системного промпта по ключу: override из таблицы prompts,
// если он непустой; иначе дефолт из config/prompts.ts. Пустая строка
// override'а трактуется как «нет override» — пользователь, вероятно, хотел
// сбросить значение, но запрос на DELETE удобнее, чем PUT с ''.
export async function getPrompt(env: Env, key: PromptKey): Promise<string> {
	const override = await getPromptOverride(env.DB, key)
	return resolveEffectivePrompt(key, override?.value)
}

// Помощник для view + чтения: единая логика «trim + fallback».
// Принимает override как `string | undefined`, чтобы переиспользовать на
// списке (`listPromptOverrides` не возвращает 404 для отсутствующего ключа).
function resolveEffectivePrompt(key: PromptKey, raw: string | undefined): string {
	const trimmed = raw?.trim() ?? ''
	return trimmed.length > 0 ? trimmed : DEFAULT_PROMPTS[key]
}

// Snapshot всех настроек одним вызовом: дефолты из кода + override'ы из D1.
// Один проход по `listPromptOverrides`, один по `getActiveModel` (внутри —
// `getSetting`). Никаких N+1 запросов по `Object.keys(DEFAULT_PROMPTS)`.
export async function listSettings(env: Env): Promise<SettingsView> {
	const [activeModel, overrides] = await Promise.all([getActiveModel(env), listPromptOverrides(env.DB)])
	const overrideByKey = new Map(overrides.map((row) => [row.key, row.value]))

	const promptKeys = Object.keys(DEFAULT_PROMPTS) as PromptKey[]
	const prompts = {} as Record<PromptKey, PromptView>
	for (const key of promptKeys) {
		const raw = overrideByKey.get(key)
		prompts[key] = {
			default: DEFAULT_PROMPTS[key],
			override: raw ?? null,
			effective: resolveEffectivePrompt(key, raw),
		}
	}

	return {
		activeModel,
		allowedModels: ALLOWED_MODELS,
		embeddingModel: EMBEDDING_MODEL,
		embeddingDimensions: EMBEDDING_DIMENSIONS,
		prompts,
	}
}

export async function setActiveModel(env: Env, model: AllowedModel): Promise<void> {
	await setSetting(env.DB, ACTIVE_MODEL_KEY, model)
}

export async function setPromptOverride(env: Env, key: PromptKey, value: string): Promise<void> {
	await upsertPromptOverride(env.DB, key, value)
}

export async function deletePromptOverride(env: Env, key: PromptKey): Promise<void> {
	await removePromptOverride(env.DB, key)
}
