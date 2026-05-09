import { Hono } from 'hono'
import type { AppBindings } from '../config/env'
import { proxyToService } from '../lib/proxy'

// Анонимные роуты: JWT ещё нет — токен только выдаётся. Поэтому JWT-middleware
// сюда не вешается (см. подключение в src/index.ts). Валидация тела
// (Zod-схема `credentialsSchema`) живёт в notetaker-auth — gateway не дублирует.
//
// Маппинг путей:
//   POST /auth/register (gateway) → POST /register (auth)
//   POST /auth/login    (gateway) → POST /login    (auth)
export const authRoutes = new Hono<AppBindings>()
	.post('/register', (c) =>
		proxyToService({ target: c.env.AUTH, request: c.req.raw, internalPath: '/register' }),
	)
	.post('/login', (c) =>
		proxyToService({ target: c.env.AUTH, request: c.req.raw, internalPath: '/login' }),
	)
