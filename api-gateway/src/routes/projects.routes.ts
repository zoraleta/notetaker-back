import { Hono } from 'hono'
import type { AppBindings } from '../config/env'
import { authenticatedProxy } from '../lib/proxy'

// Защищённые роуты проектов (F3). JWT-middleware вешается на `/projects/*`
// в src/index.ts, поэтому к моменту входа сюда `c.get('user')` уже валидирован.
//
// `from-pack` ПЕРЕД `/:id` — Hono использует first-match.
// Тело и query валидируются в notetaker-projects (Zod-схемы там же), gateway
// не парсит и не дублирует валидацию.
const proxyProjects = authenticatedProxy('PROJECTS')

export const projectsRoutes = new Hono<AppBindings>()
	.post('/from-pack', proxyProjects)
	.post('/', proxyProjects)
	.get('/', proxyProjects)
	.get('/:id', proxyProjects)
	.patch('/:id', proxyProjects)
	.delete('/:id', proxyProjects)
