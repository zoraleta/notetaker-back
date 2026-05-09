import { Hono } from 'hono'
import type { AppBindings } from '../config/env'
import { authenticatedProxy } from '../lib/proxy'

// Защищённые роуты AI-функций (Phase 5B-5G). JWT-middleware вешается
// на `/ai/*` в src/index.ts, поэтому к моменту входа сюда `c.get('user')`
// уже валидирован.
//
// Префиксы: фронт зовёт `/ai/<endpoint>`, ai-воркер слушает `/<endpoint>`
// (без `/ai/` — это «неймспейс» только для фронта). Поэтому передаём
// `internalPath` без префикса `/ai`.
//
// `/notes/:id/similar` тоже AI-эндпоинт, но живёт в notes.routes.ts —
// иначе нарушится URL-структура «всё про заметку под /notes/:id».
//
// Тело и query валидируются в notetaker-ai (Zod-схемы там же), gateway
// не парсит и не дублирует валидацию.

// Стримы (text/event-stream) проходят через Service Bindings прозрачно:
// `authenticatedProxy` возвращает `target.fetch(...)` без `.json()`/`.text()`,
// Hono тоже не буферизует Response с ReadableStream. Поэтому `/summarize`
// (Phase 5D, SSE) и будущий `/discuss` (Phase 5G) используют тот же helper.
export const aiRoutes = new Hono<AppBindings>()
	.post('/search', authenticatedProxy('AI', '/search'))
	.post('/summarize', authenticatedProxy('AI', '/summarize'))
	.post('/classify', authenticatedProxy('AI', '/classify'))
	.get('/develop-suggestions', authenticatedProxy('AI', '/develop-suggestions'))
