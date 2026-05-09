// Хелпер для прозрачного проксирования запроса в internal-воркер
// через Service Binding (CLAUDE.md → правило 8 «Worker→worker — только Service Bindings»).
//
// Зачем переделываем URL: gateway-роуты живут под префиксом (например, /auth/register),
// а internal-воркеры слушают «свой» путь (/register). Переписываем pathname на
// internalPath и прокидываем тело/заголовки исходного запроса как есть.
//
// userId ставим заголовком x-user-id из jwt-middleware: внутренние воркеры
// доверяют ему и сами JWT не парсят (CLAUDE.md → правило 11).
export interface ProxyOptions {
	target: Fetcher
	request: Request
	internalPath: string
	userId?: string
}

export function proxyToService({ target, request, internalPath, userId }: ProxyOptions): Promise<Response> {
	const url = new URL(request.url)
	url.pathname = internalPath

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
