import { Hono, type Context } from 'hono'
import type { AppBindings } from '../config/env'
import { proxyToService } from '../lib/proxy'

// Защищённые роуты заметок (F2). JWT-middleware вешается в src/index.ts на
// префикс `/notes/*`, поэтому к моменту входа сюда у нас уже валидный
// `c.get('user')`. Префикс пути в gateway и в notetaker-notes одинаковый
// (`/notes/...`) — `internalPath` не переписываем, helper сохраняет URL.
//
// Тело и query валидируются в notetaker-notes (Zod-схемы там же), gateway
// не парсит и не дублирует валидацию.
const proxyNotes = (c: Context<AppBindings>): Promise<Response> =>
	proxyToService({
		target: c.env.NOTES,
		request: c.req.raw,
		userId: c.get('user').id,
	})

export const notesRoutes = new Hono<AppBindings>()
	.post('/', proxyNotes)
	.get('/', proxyNotes)
	.get('/:id', proxyNotes)
	.patch('/:id', proxyNotes)
	.delete('/:id', proxyNotes)
