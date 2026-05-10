import { Hono } from 'hono'
import type { AppBindings } from '../config/env'
import { authenticatedProxy } from '../lib/proxy'

// Группы (Phase 8). JWT-middleware вешается на `/groups/*` в src/index.ts.
// Всё проксируется в notetaker-notes — там живут D1-таблица groups и бизнес-логика.
const proxyNotes = authenticatedProxy('NOTES')

export const groupsRoutes = new Hono<AppBindings>()
	.get('/', proxyNotes)
	.post('/', proxyNotes)
	.patch('/:id', proxyNotes)
	.delete('/:id', proxyNotes)
