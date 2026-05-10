import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { err, ok, type Result } from '../lib/result'

// User-Agent: некоторые сайты возвращают пустую страницу или 403 на пустой/
// бот-подобный UA. Браузерный UA с пометкой нашего сервиса — компромисс между
// «не маскируемся» и «нас не банят на старте».
const USER_AGENT = 'Mozilla/5.0 (compatible; notetaker/1.0)'

// Cloudflare edge кэширует ответ исходного URL — повторный запрос на ту же
// статью в течение 10 минут не дёргает сервер источника. Дефолт из tech-plan.
const FETCH_CACHE_TTL_SECONDS = 600

// Минимальная длина текста, ниже которой считаем, что страницы не существует
// (paywall, JS-only SPA, robots wall, ошибочная страница). Дефолт из tech-plan.
const MIN_CONTENT_LENGTH = 200

// Длина, до которой обрезаем фолбэковый extract (`<main>` / `<article>` /
// `<body>`): не пускаем целую SPA-страницу в саммари, но даём AI достаточно
// текста, чтобы он сам разобрался. Дефолт из tech-plan.
const FALLBACK_MAX_LENGTH = 10_000

export interface ParseSuccess {
	title: string
	byline: string | null
	content: string
	excerpt: string
}

// Контракт parser-сервиса. Доменные ошибки (paywall, 404, no-content) —
// EXTERNAL: для вызывающего фронта это «внешняя ошибка» (источник не
// извлекается), а не баг нашей системы. Невалидный URL отлавливается Zod-ом
// раньше — в сервис не попадает.
export async function parseUrl(url: string): Promise<Result<ParseSuccess>> {
	const html = await fetchHtml(url)
	if (!html.ok) return html

	const parsed = extractWithReadability(html.data)
	if (parsed) return ok(parsed)

	const fallback = extractFallback(html.data)
	if (fallback) return ok(fallback)

	return err('Не удалось извлечь содержательный текст со страницы', 'EXTERNAL')
}

async function fetchHtml(url: string): Promise<Result<string>> {
	let response: Response
	try {
		response = await fetch(url, {
			headers: { 'user-agent': USER_AGENT },
			cf: { cacheTtl: FETCH_CACHE_TTL_SECONDS, cacheEverything: true },
		})
	} catch {
		// Network-уровневые сбои (DNS, TLS, оборванное соединение). На клиенте
		// это «не удалось загрузить страницу», стоят те же действия, что и при
		// 5xx — поэтому общий код EXTERNAL.
		return err('Не удалось загрузить страницу', 'EXTERNAL')
	}

	if (!response.ok) {
		return err(`Источник вернул статус ${response.status}`, 'EXTERNAL')
	}

	const html = await response.text()
	if (html.length === 0) {
		return err('Источник вернул пустой ответ', 'EXTERNAL')
	}
	return ok(html)
}

function extractWithReadability(html: string): ParseSuccess | null {
	// Readability ожидает DOM Document (lib "dom"), но lib "dom" в Workers
	// конфликтует с @cloudflare/workers-types. linkedom возвращает собственный
	// document, структурно совместимый с тем, что использует Readability
	// (querySelector*, textContent, baseURI, ...). Cast `as never` — единственный
	// способ обойти проверку без подключения dom lib.
	const { document } = parseHTML(html)
	const article = new Readability(document as never).parse()
	if (!article) return null

	const content = article.textContent?.trim() ?? ''
	if (content.length < MIN_CONTENT_LENGTH) return null

	return {
		title: article.title?.trim() ?? '',
		byline: article.byline?.trim() || null,
		content,
		excerpt: article.excerpt?.trim() ?? '',
	}
}

function extractFallback(html: string): ParseSuccess | null {
	const { document } = parseHTML(html)

	// Идём по убыванию специфичности: <main> — обычно главный контент SPA,
	// <article> — статейные сайты без главной обвязки, <body> — последний
	// шанс «хоть что-то отдать». Останавливаемся на первом, который даёт
	// достаточный текст.
	const candidates = ['main', 'article', 'body']
	for (const selector of candidates) {
		const element = document.querySelector(selector)
		const raw = element?.textContent?.trim() ?? ''
		if (raw.length < MIN_CONTENT_LENGTH) continue

		const content = raw.length > FALLBACK_MAX_LENGTH ? raw.slice(0, FALLBACK_MAX_LENGTH) : raw

		// Title — из <title> или первого <h1>; обе обвязки не Readability,
		// поэтому достаём руками.
		const title = (document.querySelector('title')?.textContent ?? document.querySelector('h1')?.textContent ?? '').trim()

		return {
			title,
			byline: null,
			content,
			excerpt: '',
		}
	}

	return null
}
