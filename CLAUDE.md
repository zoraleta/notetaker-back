# notetaker-back

Бэкенд для notetaker (тестовое задание Mediacube). Серверлесс на Cloudflare, AI-first, **микросервисная архитектура** на отдельных воркерах с Service Bindings.

> **Эта папка — общая документация бэка** (правила, агенты-ревьюеры, dev-pipeline, `docs/modules/<module>.md`). Сами воркеры — отдельные top-level папки рядом (`api-gateway`, `auth`, …). Все воркеры подчиняются правилам из этого файла.

> **Соглашение об именах:** папки воркеров — без префикса (`auth`, `api-gateway`, `notes`, `ai`, `parser`, `projects`). Поле `name` в `wrangler.toml` (публичное имя воркера в Cloudflare-аккаунте) — с префиксом `notetaker-` (`notetaker-auth`, `notetaker-api-gateway`, …). Тот же префикс используется в `service = "..."` в Service Bindings.

---

## Принципы разработки

### DRY (Don't Repeat Yourself)
Логика, встречающаяся более одного раза, выносится в функцию/хелпер. Дублирование — ошибка.

### KISS (Keep It Simple, Stupid)
Простое решение лучше сложного. Не усложнять «на будущее» — проектировать под текущую задачу.

### YAGNI (You Aren't Gonna Need It)
Не писать код, который «может понадобиться». Только то, что нужно прямо сейчас.

### SOLID
- **S** — каждый сервис/функция делает одно дело
- **O** — расширять через композицию, не через модификацию работающего
- **L** — не ломать контракты при имплементации интерфейсов
- **I** — узкие интерфейсы вместо монолитных
- **D** — зависеть от абстракций (типов/интерфейсов), не от конкретики

---

## Язык проекта

- Тексты для пользователя (тексты ошибок API, промпты на русском, если того требует продукт) — **русский**
- Код (имена переменных, функций, типов, файлов) — **английский**
- Комментарии в коде — **русский**
- Сообщения коммитов — **английский** (conventional commits: `feat(scope): ...`)

---

## Стек

- **Runtime:** Cloudflare Workers
- **Framework:** Hono
- **DB:** Cloudflare D1 (SQLite) — **одна общая БД**, биндится в воркеры, которым нужен доступ
- **ORM:** Drizzle (миграции через `drizzle-kit` + `wrangler d1 migrations`)
- **Validation:** Zod + `@hono/zod-validator`
- **Auth:** JWT (выдаёт `auth`, проверяет middleware в `api-gateway`) + Oslo/Scrypt для паролей
- **AI:** **Cloudflare Workers AI** через нативный binding `env.AI.run(model, input)` — **только в `ai`**. Никакого OpenAI SDK / прямых HTTP-вызовов внешних LLM.
- **Vector DB:** **Cloudflare Vectorize** через binding `env.VECTORIZE` — **только в `ai`**. Embeddings через Workers AI (`@cf/baai/bge-m3`, 1024 dim, multilingual). Используется для семантического поиска, «похожих заметок», RAG и auto-классификации.
- **Inter-worker:** **Service Bindings** (`env.AI.fetch(...)` или RPC). Никаких HTTP-вызовов между своими воркерами.
- **Деплой:** `wrangler deploy` отдельно для каждого воркера

---

## Архитектура микросервисов

### Структура репозитория

```
mediacube-test-task/
├── notetaker-back/           ← общая документация (этот файл, .claude/agents, docs/)
├── api-gateway/              ← единственный publicly-exposed воркер
├── auth/                     ← internal: регистрация, логин, JWT
├── notes/                    ← internal: CRUD заметок
├── ai/                       ← internal: саммарайз, классификация, разгон тем (Workers AI)
├── parser/                   ← internal: фетч URL + extract контента
├── projects/                 ← internal: упаковка идей в проекты
└── notetaker-front/          ← Cloudflare Pages
```

> Состав воркеров финализируется в Phase 1 декомпозиции. Список выше — стартовая точка, может корректироваться.

### Принципы

1. **`api-gateway` — единственный воркер с публичным URL.** Только он принимает запросы фронта и проксирует их во внутренние воркеры через Service Bindings.
2. **Внутренние воркеры** не имеют публичного URL и не настраивают CORS. Их «фронтом» является `api-gateway`.
3. **JWT-middleware и CORS живут в `api-gateway`.** Внутренние воркеры доверяют `userId`, переданному gateway-ем (через RPC-аргументы или заголовок `x-user-id` — выбираем единый стиль на старте).
4. **Workers AI binding (`env.AI: Ai`) — только в `ai`.** Остальные воркеры зовут AI исключительно через Service Binding к ai-воркеру.
5. **Vectorize binding (`env.VECTORIZE: VectorizeIndex`) — тоже только в `ai`.** Все vector-операции (upsert/query/deleteByIds) централизованы в ai-воркере. Остальные воркеры (например, `notes` после создания/обновления/удаления заметки) зовут ai-воркер через Service Binding.
6. **D1 одна** (`notetaker`), биндится в воркеры, которым нужны соответствующие таблицы.
7. **Состав воркеров фиксирован.** Не плодить новые воркеры под мелкие задачи — это over-engineering. Если задача не тянет на отдельный домен, она встраивается в существующий воркер.
8. **Общие Zod-схемы и типы** — копируются между воркерами (trade-off за простоту запуска при отдельных папках). Не выделять в общий npm package, пока их не будет 5+ повторений с реальными расхождениями.

### Поток запроса

```
front → api-gateway (CORS, JWT, Zod) → SVC binding → internal worker (бизнес, D1) → ответ → gateway → front
```

Длинные AI-операции — через `c.executionCtx.waitUntil()` в ai-воркере: фронту мгновенно `202 Accepted`, результат подбирается отдельным запросом.

---

## Структура внутри одного воркера

```
src/
├── routes/         Hono-роуты, Zod-валидаторы, вызов сервисов
├── services/       Бизнес-логика, HTTP-agnostic (без Context/Request)
├── db/             Drizzle schema + функции запросов (если воркер ходит в D1)
│   ├── schema.ts
│   └── *.queries.ts
├── middleware/     auth (JWT — только в api-gateway), error handler, CORS (только в gateway)
├── lib/            универсальные хелперы (хеширование, даты)
├── config/         парсинг env, дефолтные промпты, константы
└── index.ts        точка входа Worker, сборка app
```

**Поток:** `request → middleware → route (Zod) → service → db / SVC binding → response`

---

## Ключевые правила

1. **Routes thin.** Роут только валидирует и зовёт сервис. Никакой бизнес-логики, никаких прямых обращений к D1/AI/другим воркерам.
2. **Сервисы HTTP-agnostic.** Сигнатуры — примитивы и типы из Zod, не `Context`/`Request`. `Env` передаётся явным аргументом.
3. **DB только через `db/`.** Сервисы не создают `drizzle()` сами.
4. **Все входы валидируются Zod** через `@hono/zod-validator` (`json` / `query` / `param`).
5. **Result<T> для ожидаемых ошибок.** `throw` — только для непредвиденных, ловится в `app.onError`.
6. **Промпты не хардкодятся.** См. раздел «Настройки AI: гибрид config + D1».
7. **Фоновая работа** через `c.executionCtx.waitUntil()` — клиент получает ответ сразу.
8. **Worker→worker — только Service Bindings**, никогда HTTP. Между воркерами нет публичных URL.
9. **AI-вызовы — только из `ai`.** Любой другой воркер, которому нужна AI, зовёт ai-воркер через Service Binding.
10. **Vectorize-операции — только из `ai`.** Любой другой воркер, которому нужно проиндексировать, найти, удалить вектор, зовёт ai-воркер через Service Binding (`env.AI.fetch('https://internal/vectors/...')`).
11. **JWT проверяется только в `api-gateway`.** Внутренние воркеры получают уже валидированный `userId` от gateway.
12. **Секреты** — только в `wrangler.toml`/dashboard, никогда в коде.
13. **Edge-совместимость.** Никаких Node-only зависимостей (`fs`, `crypto` в Node-стиле, тяжёлые ORM).

---

## Типы Env и Variables

Различаются между gateway и internal-воркерами.

### `api-gateway`

```ts
// Единственный воркер с публичным URL. Здесь Service Bindings, JWT и CORS.
export interface Env {
  DB?: D1Database              // если gateway сам хранит сессии/мета — иначе можно опустить
  JWT_SECRET: string
  AUTH: Fetcher                // Service Binding на воркер auth
  NOTES: Fetcher
  AI: Fetcher                  // Service Binding на воркер ai (НЕ Workers AI binding!)
  PARSER: Fetcher
  PROJECTS: Fetcher
}

type Variables = {
  user: { id: string; email: string }  // ставится JWT-middleware
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>()
```

`wrangler.toml` (gateway):
```toml
[[d1_databases]]
binding = "DB"
database_name = "notetaker"
database_id = "..."

[[services]]
binding = "AUTH"
service = "notetaker-auth"

[[services]]
binding = "NOTES"
service = "notetaker-notes"

[[services]]
binding = "AI"
service = "notetaker-ai"

# и т.д. для PARSER, PROJECTS
```

### `ai`

```ts
// Единственный воркер с биндингами Workers AI и Vectorize.
export interface Env {
  DB: D1Database
  AI: Ai                       // Workers AI binding (env.AI.run(model, input))
  VECTORIZE: VectorizeIndex    // Cloudflare Vectorize (env.VECTORIZE.insert/query/...)
}
```

`wrangler.toml`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "notetaker"
database_id = "..."

[ai]
binding = "AI"

[[vectorize]]
binding = "VECTORIZE"
index_name = "notetaker-vectors"   # создан через wrangler vectorize create
```

### `auth` / `notes` / `projects` / `parser`

```ts
// Internal-воркеры без публичного URL. JWT уже проверен в gateway.
export interface Env {
  DB: D1Database               // если работает с D1
  // никакого JWT_SECRET — проверка только в gateway
  // никакого env.AI — AI-запросы через Service Binding из gateway
}
```

`parser` может не нуждаться в `DB`, если результаты возвращает gateway-ю и сам ничего не пишет.

### Вызов AI из ai-воркера

```ts
// ai/src/services/ai.service.ts
import { getActiveModel, getPrompt } from '@/config/ai'

export async function summarize(env: Env, text: string) {
  const model = await getActiveModel(env)            // см. «Настройки AI»
  const systemPrompt = await getPrompt(env, 'summarize')
  const response = await env.AI.run(model, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text },
    ],
  })
  return response.response
}
```

### Вызов AI-воркера из gateway

```ts
// api-gateway/src/services/ai-client.ts
export async function summarize(env: Env, text: string): Promise<string> {
  const res = await env.AI.fetch('https://internal/summarize', {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
  if (!res.ok) throw new Error('AI worker failed')
  return (await res.json<{ summary: string }>()).summary
}
```

---

## Настройки AI: гибрид config + D1

**Цель:** дефолты гарантированно работают «из коробки», а с фронта (`/settings`) можно переопределять промпты и активную модель без редеплоя.

- **Дефолты — в коде** `ai/src/config/prompts.ts` и `ai/src/config/ai-models.ts`. Это типизированный whitelist.
- **Переопределения — в D1** (таблицы `prompts(key, value, updatedAt)` и `settings(key, value)`). При чтении: если в D1 запись есть — берём её, иначе fallback на `DEFAULT_*`.
- **Активная модель** — это запись в `settings` с `key='active_model'`, значение — id **из whitelist** `ALLOWED_MODELS`. Произвольную строку не принимаем.

```ts
// ai/src/config/ai-models.ts
export const ALLOWED_MODELS = [
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
] as const
export type AllowedModel = (typeof ALLOWED_MODELS)[number]
export const DEFAULT_MODEL: AllowedModel = '@cf/meta/llama-3.1-8b-instruct'

// Embedding-модели — отдельный whitelist.
// ВАЖНО: смена модели = смена dimensions = новый Vectorize-индекс.
// Поэтому через UI переключаем только chat-модель (выше). Embedding-модель — константа.
export const EMBEDDING_MODEL = '@cf/baai/bge-m3' as const
export const EMBEDDING_DIMENSIONS = 1024
```

```ts
// ai/src/services/settings.service.ts
export async function getActiveModel(env: Env): Promise<AllowedModel> {
  const saved = await getSetting(env, 'active_model')
  if (saved && (ALLOWED_MODELS as readonly string[]).includes(saved)) {
    return saved as AllowedModel
  }
  return DEFAULT_MODEL
}
```

CRUD настроек живёт в `ai`. Gateway проксирует `/settings/*` через Service Binding.

---

## Векторный индекс (Vectorize)

### Параметры индекса (фиксируются при создании)

- **Index name:** `notetaker-vectors`
- **Embedding model:** `@cf/baai/bge-m3` (multilingual, поддерживает русский)
- **Dimensions:** `1024` (диктуется моделью; смена модели = новый индекс)
- **Metric:** `cosine`
- **Создание:** `wrangler vectorize create notetaker-vectors --dimensions=1024 --metric=cosine`

### Что хранится

Один вектор на единицу контента, которая должна быть найдена по смыслу. На старте — заметки.

```
id:        note:<noteId>
values:    Float32Array(1024)
metadata: {
  userId:    string,           // ОБЯЗАТЕЛЬНО — для фильтрации в query
  noteId:    string,
  projectId: string | null,    // если заметка прикреплена к проекту
  type:      'note',           // на будущее: 'note' | 'project' | ...
  updatedAt: number,           // ms epoch — для актуальности
}
namespace: <userId>            // изоляция данных пользователей
```

**Изоляция пользователей** — через **namespace** (не через фильтр в metadata). Так Vectorize ищет только в подмножестве пользователя по индексной структуре.

### Сценарии и операции

| Сценарий | Операция | Где живёт код |
|----------|----------|---------------|
| Семантический поиск (Cmd+K) | `embed(query) → VECTORIZE.query(namespace=userId, topK=N)` | `ai/services/search.service.ts` |
| «Похожие заметки» | `VECTORIZE.query(by id=note:<noteId>)` или `query(values=<savedVector>)` | `ai/services/search.service.ts` |
| RAG для AI-разгона | `embed(currentText) → VECTORIZE.query(topK=5)` → подмешать в системный промпт | `ai/services/discuss.service.ts` |
| Auto-классификация | `query` против центроидов проектов/тегов (тоже хранятся как векторы) | `ai/services/classify.service.ts` |

### Жизненный цикл вектора заметки

| Событие в `notes` | Действие в `ai` (через SVC binding) |
|-----------------------------|-----------------------------------------------|
| Создание / обновление текста | `POST /internal/vectors/upsert` → embed + `VECTORIZE.upsert([{ id: 'note:'+id, values, metadata }])` |
| Удаление заметки | `POST /internal/vectors/delete` → `VECTORIZE.deleteByIds(['note:'+id])` |
| Изменение `projectId` | `upsert` (метаданные обновляются вместе с вектором) |

Эмбеддинг новой заметки запускается через `c.executionCtx.waitUntil(...)` в gateway — клиент получает `201` сразу, индексация идёт в фоне.

### Правила

1. **`env.VECTORIZE` существует только в `ai`.** Любой другой воркер использует Service Binding.
2. **Namespace = `userId`.** Никогда не делать незапрещаемых cross-user query.
3. **`metadata.userId` — дублирующий guard.** При query всегда добавляем `filter: { userId }` поверх namespace, на случай ошибки в namespace.
4. **`id` = детерминированный** (`note:<uuid>`). Не использовать счётчик/random — иначе при upsert получим дубли.
5. **Не строить «теневую» таблицу векторов в D1.** Vectorize и есть хранилище. В D1 храним только мета-флаг `is_indexed_at` на заметке (для отладки/реиндекса).
6. **Не писать обёртку `BaseVectorRepository`.** Native API из 4 методов короткий — пишем прямые вызовы в `db/vectors.queries.ts` (название по аналогии с D1-queries, хотя физически это Vectorize).
7. **Mass-reindex** (если придётся менять модель/размерность) — отдельный admin-эндпоинт, который проходит по всем заметкам пользователя и пере-upsert'ит. До появления реальной потребности не реализуем.

---

## Result<T>

```ts
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: 'NOT_FOUND' | 'FORBIDDEN' | 'VALIDATION' | 'EXTERNAL' }
```

---

## Команды

Команды выполняются **внутри папки конкретного воркера** (например `cd auth && npm run dev`).

```bash
npm run dev          # wrangler dev — запуск воркера локально
npm run typecheck    # tsc --noEmit
npm run lint         # eslint (если настроен)
npm run db:generate  # drizzle-kit generate (только в воркерах с D1)
npm run db:apply     # wrangler d1 migrations apply notetaker --local
npm run deploy       # wrangler deploy
```

Создание Vectorize-индекса (выполняется один раз в облаке, до первого деплоя `ai`):

```bash
# из любой папки, где есть wrangler
wrangler vectorize create notetaker-vectors --dimensions=1024 --metric=cosine
# затем: index_name="notetaker-vectors" уже прописан в ai/wrangler.toml
```

Локальная разработка: `wrangler dev` в gateway автоматически поднимает Service Bindings к остальным воркерам, если они тоже запущены через `wrangler dev` параллельно (или объявлены как `dev = { remote = true }`). **Vectorize в локальном `wrangler dev` ходит на удалённый индекс** (нужен `wrangler login`) — используем тестовый namespace вроде `dev:<userId>`, чтобы не засорять прод-данные.

---

## Пайплайн разработки

См. [`docs/dev-pipeline-back.md`](docs/dev-pipeline-back.md). Quick Pipeline для мелких/средних правок, Full Pipeline для крупных фич с декомпозицией и финальным ревью. **На Phase 0 / Q1 обязательно указывается, в каком воркере идёт работа.**

## Агенты-ревьюеры (`.claude/agents/`)

| Агент | Когда вызывать |
|-------|----------------|
| `pragmatic-architect` | На этапе планирования и в финале — против over-engineering, в т.ч. неоправданных новых воркеров |
| `api-guardian` | После реализации — Hono/Zod/Drizzle/auth/Service Bindings паттерны |
| `clean-code-guardian` | После реализации — структура слоёв, naming, размеры |

Нейросеть **обязана** автоматически вызывать `api-guardian` и `clean-code-guardian` после написания кода (см. шаг Q2 / 2.3 в пайплайне).

---

## Антипаттерны (см. полный список в `docs/dev-pipeline-back.md`)

- Бизнес-логика в роуте
- `Context`/`Request` в сигнатуре сервиса
- Прямой `c.env.DB.prepare(...)` в сервисе
- HTTP-вызов между своими воркерами вместо Service Binding
- Workers AI binding в воркере, который не `ai`
- Vectorize binding в воркере, который не `ai`
- JWT-проверка во внутреннем воркере (должна быть только в gateway)
- Создание нового воркера под одну функцию вместо встраивания в существующий
- Хардкод системных промптов
- Хранение векторов в D1 «параллельно» с Vectorize-индексом
- Обёртка `BaseVectorRepository` поверх Vectorize (нативный API короткий)
- Repository/BaseService обёртки над Drizzle (Drizzle уже типизирован)
- Node-only зависимости

---

## Именование

| Сущность | Стиль | Пример |
|---|---|---|
| Файл | kebab-case | `notes.service.ts`, `jwt-middleware.ts` |
| Функция/переменная | camelCase | `fetchNoteById`, `userId` |
| Тип/интерфейс | PascalCase | `CreateNoteInput`, `Env` |
| Константа | UPPER_SNAKE_CASE | `MAX_NOTE_LENGTH`, `DEFAULT_MODEL` |
| Boolean | `is*` / `has*` / `can*` | `isAuthenticated`, `hasAccess` |
| Функция-действие | глагол + существительное | `summarizeArticle`, `insertNote` |
| Папка воркера | kebab-case без префикса | `auth`, `api-gateway` |
| Имя воркера в Cloudflare (`name` в `wrangler.toml`) | kebab-case с префиксом `notetaker-` | `notetaker-auth`, `notetaker-api-gateway` |
| Service Binding (ключ в `Env`) | UPPER_SNAKE_CASE | `AUTH`, `AI`, `PARSER` |

Без сокращений, кроме общепринятых: `id`, `url`, `db`, `jwt`, `ai`.

---

## Документация модулей (`docs/modules/`)

Каждый домен (auth, notes, ai, parser, projects, …) обязан иметь файл `docs/modules/<module>.md` в `notetaker-back/docs/modules/` (общая папка для всех воркеров).

**Стиль:** сухо, без воды, **без примеров кода**. Только факты для понимания логики и зависимостей.

**Структура файла:**
```markdown
# <module>

Одна фраза: что делает модуль.

## Воркер
`notetaker-<name>` — в каком воркере физически живёт.

## Логика работы
Последовательность операций, ключевые алгоритмы, потоки данных.

## Зависимости
Внешние сервисы (Workers AI), таблицы D1, другие воркеры через Service Binding.

## Routes (публичные через gateway)
- `METHOD /path` — что делает, какая Zod-схема входа.

## Internal endpoints / RPC
- `METHOD /internal/...` или RPC-метод, который зовёт gateway / другой воркер.

## Services
- `serviceName(args)` — что делает, какие side effects.

## Queries (db/)
- `queryName(args)` — что возвращает, на какую таблицу.

## Ограничения
Бизнес-правила и инварианты, которые нельзя нарушать.
```

**Правила:**
- Обновлять **сразу после** изменения кода модуля — документация всегда актуальна.
- Перед работой с модулем нейросеть обязана прочитать `docs/modules/<module>.md`.
- Публичный API модуля — через `services/<module>/index.ts`, внутренние файлы снаружи (даже из соседних модулей того же воркера) не импортируются.

---

## Правила работы с AI (Claude Code)

### Перед написанием кода

1. **Step-by-Step Thinking.** Кратко (одним абзацем) описать план: в каком воркере работаешь, какие файлы создашь, что изменишь, как это решит задачу.
2. **Прочитать существующий код и доку модуля** (`docs/modules/<module>.md`), не предполагать структуру.
3. **Одна задача за раз** — не рефакторить попутно то, о чём не просили.
4. **Не трогать рабочий код** под предлогом «улучшения», если задача не про это.
5. **Не создавать новый воркер**, если задача решается в существующем.

### После написания кода

1. **Verification Step.** Внутренняя проверка: типы TypeScript, нет лишних импортов, соблюдены правила этого файла, корректные Service Bindings.
2. `npm run typecheck` обязательно (в каждом затронутом воркере).
3. Если изменена схема D1 — сгенерирована и проверена миграция.
4. Если добавлен/изменён Service Binding — обновлены `wrangler.toml` всех затронутых воркеров и тип `Env` в gateway.
5. Вызваны агенты-ревьюеры (см. пайплайн).

### При неопределённости — остановиться и уточнить

Не гадать, а задать вопрос с вариантами, если:
- Непонятно, в каком воркере / слое / модуле должна быть логика
- Есть несколько равноценных архитектурных подходов
- Задача затрагивает несколько воркеров и неясен порядок изменений
- Edge cases / поведение при ошибке не описаны

### Запрещено без явного запроса

- Создавать новые воркеры
- Добавлять новые зависимости в `package.json`
- Менять структуру слоёв (`routes/services/db`)
- Превращать internal-воркер в публично-доступный (давать ему свой Route в `wrangler.toml`)
- Рефакторить рабочий код под предлогом «улучшения»
- Добавлять комментарии к коду, который не изменялся
- Писать `TODO` / `FIXME` / `HACK` без обсуждения
- Создавать новые файлы, если задача решается правкой существующих
- Использовать `console.log` в коммите (только для временной отладки с последующим удалением)
- Использовать `any`

### Масштаб изменений

- **Минимальный diff = лучший diff.**
- Изменение должно быть ровно настолько большим, насколько нужно для задачи.
- Если задача большая — разбить на шаги и согласовать подход (Full Pipeline).
