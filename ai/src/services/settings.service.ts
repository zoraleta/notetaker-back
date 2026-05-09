import type { Env } from '../config/env'
import { ALLOWED_MODELS, DEFAULT_MODEL, type AllowedModel } from '../config/ai-models'
import { DEFAULT_PROMPTS, type PromptKey } from '../config/prompts'
import { getSetting } from '../db/settings.queries'
import { getPromptOverride } from '../db/prompts.queries'

// Гибридное чтение настроек: D1 → fallback на дефолты в коде.
// Используется всеми AI-сервисами Phase 5 (summarize, classify, discuss, pack).
// CRUD-эндпоинты `/settings/*` для записи появятся в Phase 5C.

const ACTIVE_MODEL_KEY = 'active_model'

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
	const trimmed = override?.value.trim() ?? ''
	if (trimmed.length > 0) {
		return trimmed
	}
	return DEFAULT_PROMPTS[key]
}
