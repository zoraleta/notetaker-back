import { Hono } from 'hono'
import type { AppBindings } from '../config/env'
import { authenticatedProxy } from '../lib/proxy'

// Защищённые роуты работы со ссылками (Phase 6, F1 extraction). JWT-middleware
// вешается в src/index.ts на префикс `/links/*`, поэтому к моменту входа сюда
// `c.get('user')` уже валидирован.
//
// Префикс: фронт зовёт `/links/parse`, parser-воркер слушает `/parse`
// (без `/links/` — это «неймспейс» только для фронта), поэтому передаём
// `internalPath: '/parse'`.
//
// Тело валидируется в notetaker-parser (Zod-схема там же), gateway не парсит
// и не дублирует валидацию.
//
// По tech-plan §6.4 «Альтернатива: фронт делает 2 запроса (1. `/links/parse`,
// 2. `/ai/summarize`)» — выбран этот вариант: gateway тонкий, без бизнес-логики
// (CLAUDE.md → правило 1 «routes thin»).
export const linksRoutes = new Hono<AppBindings>().post('/parse', authenticatedProxy('PARSER', '/parse'))
