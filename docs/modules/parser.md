# parser

Извлечение заголовка/автора/основного текста по URL. F1 (часть «extraction»). Stateless: ни D1, ни Vectorize не использует.

## Воркер
`notetaker-parser` — internal-воркер без публичного `routes`. Доступен только через Service Binding `PARSER` из `notetaker-api-gateway`. Не имеет биндингов на D1/Workers AI/Vectorize: extraction — pure transform `URL → текст`.

## Логика работы

**Поток (`POST /parse`)**
1. Zod-валидация body: `url` — `https?:` ссылка длиной ≤ 2048 символов. Невалидный URL / неподдерживаемая схема / превышение длины → `400 VALIDATION` (через общий `validationHook`).
2. `parseUrl(url)`:
	- `fetchHtml(url)` — `fetch` с `User-Agent: Mozilla/5.0 (compatible; notetaker/1.0)` и `cf: { cacheTtl: 600, cacheEverything: true }` (Cloudflare edge кэширует ответ источника на 10 минут — повторный запрос на ту же статью идёт из кэша).
	- Network-сбой / non-2xx / пустое тело → `Result.err('...', 'EXTERNAL')` → `502`.
	- `extractWithReadability(html)` — `linkedom.parseHTML` → `@mozilla/readability`. Если `article` есть и `textContent.length ≥ 200` → возвращаем `{ title, byline, content, excerpt }`. Иначе `null`.
	- Fallback `extractFallback(html)` — обходит `<main>` → `<article>` → `<body>`, берёт первый, у которого `textContent.length ≥ 200`. Обрезает до 10 000 символов. `title` достаём из `<title>` или первого `<h1>`. `byline = null`, `excerpt = ''`.
	- Если оба пути вернули `null` → `Result.err('...', 'EXTERNAL')` → `502`.
3. Успех — `200 ParseSuccess`. Любая «страница не разобралась» (404, paywall, JS-only SPA, robots wall, < 200 символов текста) — единый `502 EXTERNAL` с осмысленным сообщением.

**Решение про формат ошибки.** Tech-plan §6 DoD предлагал «404 / paywall → `200 { ok: false, error }`». При планировании Phase 6 выбрано **отклонение**: единый стиль с другими воркерами — доменные ошибки приходят в `Result<T>` и маппятся `STATUS_BY_CODE` на 4xx/5xx; `EXTERNAL → 502`. Цена — фронт ловит 502 в `links/parse` так же, как ловит другие `Result.err`-ошибки (общий error-handler), без discriminated union на пустом успехе.

**Решение про Cloudflare-кэш.** `cacheEverything: true` нужен потому, что не все источники отдают `Cache-Control: public` — без флага Cloudflare уважает их `private/no-store`, и `cacheTtl` игнорируется. Для нашего use case (фоновое извлечение под один и тот же URL фронт делает дважды: при создании заметки и при последующем re-summarize) — экономнее принудительно кешировать.

**Без таймаута/abort.** Workers и так имеют CPU-лимит. Подписной timeout на `fetch` не нужен (YAGNI): Workers AI (`/summarize`) — отдельный шаг, и фронт сам показывает индикатор. Если в будущем долгие источники начнут забивать executionCtx — добавим `AbortSignal.timeout`.

**Без обхода SSRF.** Cloudflare Workers ходят через публичный интернет; локальные/RFC1918-адреса с edge недостижимы. Поэтому достаточно ограничить схему `http(s)` через Zod, а отдельной allow/blocklist по IP не делаем.

## Зависимости

- **Внешние пакеты:** `hono`, `@hono/zod-validator`, `zod`, `linkedom` (edge-совместимый DOM-парсер), `@mozilla/readability` (экстрактор основного текста).
- **D1 / Workers AI / Vectorize / Service Bindings — не имеет.** Если когда-нибудь parser начнёт писать историю парсингов — это **отдельное** решение.

## Routes (через gateway, под JWT-middleware)

- `POST /links/parse` — body `{ url: string }` (http/https, ≤ 2048 симв).
	- `200 { title: string, byline: string | null, content: string, excerpt: string }` — успешное извлечение (Readability или fallback). `byline` = автор, `excerpt` = краткая выдержка от Readability (для fallback — пустая строка). `content` — plain text без HTML-разметки, обрезан в fallback до 10 000 симв.
	- `400 { error, code: 'VALIDATION' }` — невалидный URL (формат / схема / длина / отсутствует поле).
	- `401 { error, code: 'UNAUTHORIZED' }` — без JWT (gateway).
	- `502 { error, code: 'EXTERNAL' }` — источник недоступен (network / 4xx / 5xx) или не удалось извлечь содержательный текст (< 200 симв во всех путях).

## Internal endpoints / RPC

- `POST /parse` — то, что слушает сам parser-воркер. Вызывается gateway-ем через Service Binding `PARSER` (`internalPath: '/parse'`). Заголовок `x-user-id` проставляется gateway-ем; парсер сам JWT не валидирует (CLAUDE.md → правило 11), но проверяет наличие `x-user-id` через `requireUserId` middleware — страховка от конфигурационного бага в gateway. Сам extraction stateless, userId семантически не используется.

## Services

- `parseUrl(url) → Promise<Result<ParseSuccess>>` *(Phase 6)* — единственная точка входа. `fetchHtml` → `extractWithReadability` → `extractFallback`. На любой непреодолимой проблеме — `Result.err(..., 'EXTERNAL')`.
- `fetchHtml(url) → Promise<Result<string>>` *(приватная)* — `fetch` с UA и Cloudflare-кэшем 10 мин; ловит network-сбой и non-2xx.
- `extractWithReadability(html) → ParseSuccess | null` *(приватная)* — `linkedom.parseHTML` → `Readability.parse()`. `null`, если `article = null` или `textContent.length < MIN_CONTENT_LENGTH`.
- `extractFallback(html) → ParseSuccess | null` *(приватная)* — обход `<main>` → `<article>` → `<body>`, обрезка до `FALLBACK_MAX_LENGTH = 10 000`. Title — из `<title>` или `<h1>`.

## Queries (db/)

Нет — воркер не работает с D1.

## Ограничения

- **Только http/https.** `file://`, `ftp://`, `data:` и т.п. отбиваются Zod-схемой на роуте. Не парсим — нет use case.
- **Максимальная длина URL — 2048 символов.** Дольше — обычно data-URL / atypical, не статья.
- **Минимальная длина извлечённого текста — 200 символов.** Меньше — считаем «страницы не существует» (paywall / SPA / wall). Возвращаем `502 EXTERNAL`.
- **Fallback-truncate — 10 000 символов.** Для чистого Readability-результата не применяем (он сам режет ровно по статье); только для `<main>/<article>/<body>` — иначе целая SPA-страница уйдёт в саммари.
- **Cloudflare-кэш на 10 минут.** Повторный `POST /links/parse` на тот же URL не дёргает источник. Если пользователь хочет «свежую версию» — это отдельный сценарий (не в Phase 6).
- **Нет ретраев и таймаутов.** Workers ограничивают CPU и так; пользовательский UX «не разобралось» — пересохранить URL вручную.
- **JWT не валидируется здесь** (CLAUDE.md → правило 11). userId приходит заголовком `x-user-id` от gateway, parser его не использует семантически — только как guard «авторизован — может парсить».
