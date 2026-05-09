import type { Context } from 'hono'
import type { AppBindings, Env } from '../config/env'

// Хелпер для прозрачного проксирования запроса в internal-воркер
// через Service Binding (CLAUDE.md → правило 8 «Worker→worker — только Service Bindings»).
//
// Когда нужен `internalPath`: префикс в gateway не совпадает с путём internal-воркера
// (например, gateway-роут `/auth/register` → auth слушает `/register`). Если префиксы
// совпадают (gateway `/notes/...` → notes тоже `/notes/...`) — `internalPath` не передаём,
// proxyToService сохранит исходный pathname.
//
// userId ставим заголовком x-user-id из jwt-middleware: внутренние воркеры
// доверяют ему и сами JWT не парсят (CLAUDE.md → правило 11).
export interface ProxyOptions {
	target: Fetcher
	request: Request
	internalPath?: string
	userId?: string
}

export function proxyToService({ target, request, internalPath, userId }: ProxyOptions): Promise<Response> {
	const url = new URL(request.url)
	if (internalPath !== undefined) {
		url.pathname = internalPath
	}

	const proxied = new Request(url, request)
	if (userId) {
		proxied.headers.set('x-user-id', userId)
	} else {
		// Защита от подмены: на анонимных роутах фронт не должен мочь сам
		// прислать x-user-id и тем самым выдать себя за другого пользователя.
		proxied.headers.delete('x-user-id')
	}

	return target.fetch(proxied)
}

// Только Service-Binding-биндинги (Fetcher), не D1/JWT_SECRET — иначе getTarget
// мог бы случайно вернуть DB и упасть на target.fetch.
type FetcherKey = {
	[K in keyof Env]: Env[K] extends Fetcher ? K : never
}[keyof Env]

// Factory защищённого прокси-handler-а для роутов под JWT-middleware.
// Используется в `notes.routes.ts` и `ai.routes.ts`: к моменту вызова
// `c.get('user')` уже валидирован, userId автоматически уходит заголовком
// `x-user-id`. internalPath опциональный — для случаев, когда префикс
// gateway отличается от пути в целевом воркере (например, `/ai/search` → `/search`).
export function authenticatedProxy(targetKey: FetcherKey, internalPath?: string) {
	return (c: Context<AppBindings>): Promise<Response> =>
		proxyToService({
			target: c.env[targetKey],
			request: c.req.raw,
			internalPath,
			userId: c.get('user').id,
		})
}
