import { Hono } from 'hono'
import type { AppBindings } from '../config/env'
import { authenticatedProxy } from '../lib/proxy'

// Защищённые роуты AI-настроек (F7, Phase 5C). JWT-middleware вешается на
// `/settings/*` в src/index.ts, поэтому к моменту входа сюда `c.get('user')`
// уже валидирован.
//
// Префиксы совпадают: фронт и ai-воркер слушают `/settings/*`,
// `internalPath` не требуется — `authenticatedProxy('AI')` сохранит pathname.
//
// Тело и параметры валидируются в notetaker-ai (Zod-схемы там же), gateway
// не парсит и не дублирует валидацию.
//
// userId передаётся заголовком `x-user-id` автоматически из JWT, но ai-воркер
// его не использует (настройки глобальные на инстанс — см. docs/modules/ai.md).
const proxyAi = authenticatedProxy('AI')

export const settingsRoutes = new Hono<AppBindings>()
	.get('/', proxyAi)
	.put('/active-model', proxyAi)
	.put('/prompts/:key', proxyAi)
	.delete('/prompts/:key', proxyAi)
