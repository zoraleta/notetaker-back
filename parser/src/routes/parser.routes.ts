import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import type { AppBindings } from '../config/env'
import { requireUserId } from '../lib/user-context'
import { toResponse, validationHook } from '../lib/http'
import { parseUrl } from '../services/parser.service'

// Лимит длины URL: RFC не нормирует, но 2048 — практический потолок,
// который держат большинство клиентов и серверов. Сильно длиннее — обычно
// уже data-URL / atypical, парсить такое не имеет смысла.
const MAX_URL_LENGTH = 2048

// Только http/https. file://, ftp://, data: и т.п. — не наш use case
// (риск SSRF на внутренние ресурсы Cloudflare-runtime, чтение local-файлов
// при ошибке маршрутизации).
const parseSchema = z.object({
	url: z
		.url('Невалидный URL')
		.max(MAX_URL_LENGTH, `URL длиннее ${MAX_URL_LENGTH} символов`)
		.refine((value) => /^https?:\/\//i.test(value), 'Поддерживаются только http(s) ссылки'),
})

export const parserRoutes = new Hono<AppBindings>()
	.use('*', requireUserId)
	.post('/parse', zValidator('json', parseSchema, validationHook), async (c) => {
		const { url } = c.req.valid('json')
		const result = await parseUrl(url)
		return toResponse(c, result, 200)
	})
