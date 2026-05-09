import { Hono } from 'hono'
import type { AppBindings } from '../config/env'
import { authenticatedProxy } from '../lib/proxy'

// Защищённые роуты заметок (F2). JWT-middleware вешается в src/index.ts
// на префикс `/notes/*`, поэтому к моменту входа сюда `c.get('user')` уже
// валидирован.
//
// `/:id/similar` — особый случай: путь под /notes/, но эндпоинт принадлежит
// AI (F8 «Похожие заметки»). Прокси идёт в notetaker-ai, не в notetaker-notes.
// **Регистрация ДО `/:id`** — Hono использует first-match, без правильного
// порядка `/:id` поглотит `/:id/similar`.
//
// Тело и query валидируются в целевом воркере (Zod-схемы там же), gateway
// не парсит и не дублирует валидацию.
const proxyNotes = authenticatedProxy('NOTES')
const proxyAiSimilar = authenticatedProxy('AI')

export const notesRoutes = new Hono<AppBindings>()
	.post('/', proxyNotes)
	.get('/', proxyNotes)
	.get('/:id/similar', proxyAiSimilar)
	.get('/:id', proxyNotes)
	.patch('/:id', proxyNotes)
	.delete('/:id', proxyNotes)
