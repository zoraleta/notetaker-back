# auth

Регистрация пользователя и логин с выдачей JWT (F6).

## Воркер
`notetaker-auth` — internal-воркер без публичного `routes`. Доступен только через Service Binding `AUTH` из `notetaker-api-gateway` (gateway появится в Phase 3). На время Phase 2 принимает запросы напрямую через `wrangler dev` для локального smoke-теста.

## Логика работы

**Регистрация (`POST /register`):**
1. Zod-валидация: email формата email, пароль ≥ 8 символов.
2. Email нормализуется (`trim().toLowerCase()`) — `User@x.com` и `user@x.com` это один пользователь.
3. Генерация `userId = crypto.randomUUID()`.
4. Хеширование пароля через Scrypt (`@noble/hashes/scrypt.js`, параметры `N=2^14, r=8, p=1, dkLen=64`, salt 16 байт). Формат хранения — `<saltBase64>:<hashBase64>`.
5. `insertUserIfFree` — атомарная вставка `INSERT … ON CONFLICT (email) DO NOTHING RETURNING id`. Если строка не вставилась → `Result.err('email_taken', 'VALIDATION')` → HTTP 400. Атомарность нужна для защиты от гонки двух параллельных регистраций с одинаковым email.
6. Подпись JWT (HS256, `JWT_SECRET`), payload `{ userId, email, iat, exp }`, TTL 7 дней.
7. Ответ `201 { token, user: { id, email } }`.

**Логин (`POST /login`):**
1. Zod-валидация (та же схема).
2. `findUserByEmail`.
3. Если пользователь не найден — гоняем `verifyDummyPassword(input.password)` (Scrypt против заранее посчитанного валидного хеша) и возвращаем `Result.err('invalid_credentials', 'UNAUTHORIZED')` → HTTP 401. Dummy-verify нужен, чтобы время ответа совпадало со случаем неверного пароля — иначе через тайминг можно перечислить email в БД.
4. Если пользователь найден — `verifyPassword` против сохранённого хеша; сравнение за постоянное время (`constantTimeEqual`).
5. Несовпадение пароля → та же ошибка `invalid_credentials` → HTTP 401 (одинаковый ответ для несуществующего email и неверного пароля).
6. Совпадение → подпись JWT, ответ `200 { token, user: { id, email } }`.

Проверка JWT в этом воркере **не выполняется** — это обязанность gateway (`CLAUDE.md` → правило 11).

## Зависимости

- **D1** (`env.DB`, общая база `notetaker`) → таблица `users`.
- **`env.JWT_SECRET`** → секрет, в проде `wrangler secret put JWT_SECRET`, локально `auth/.dev.vars`.
- **Внешние пакеты:** `hono`, `@hono/zod-validator`, `zod`, `drizzle-orm`, `@noble/hashes` (Scrypt — `@oslojs/crypto` 1.x scrypt больше не экспортирует), `@oslojs/encoding` (base64), `@tsndr/cloudflare-worker-jwt`.

Других воркеров напрямую не зовёт.

## Routes (через gateway, появятся в Phase 3)
- `POST /auth/register` — JSON `{ email, password }`. На стороне auth — `POST /register`.
- `POST /auth/login` — JSON `{ email, password }`. На стороне auth — `POST /login`.

## Internal endpoints / RPC
- `POST /register` — вход для gateway (через Service Binding `AUTH.fetch`).
- `POST /login` — то же.

Других internal-эндпоинтов нет.

## Services
- `registerUser(env, { email, password }) → Result<AuthSuccess>` — нормализует email, генерирует id, хеширует пароль, атомарно вставляет в БД (`insertUserIfFree`), подписывает JWT.
- `loginUser(env, { email, password }) → Result<AuthSuccess>` — нормализует email, ищет пользователя; в ветке «нет пользователя» прогоняет dummy-verify; верифицирует пароль; подписывает JWT. Все негативные ветки — единый код `UNAUTHORIZED` с одинаковым сообщением и временем ответа.
- `hashPassword(password) → string` — Scrypt + base64-формат `<salt>:<hash>`.
- `verifyPassword(password, stored) → boolean` — Scrypt + constant-time compare.
- `verifyDummyPassword(password) → void` — гоняет Scrypt против фиктивного хеша, чтобы выровнять тайминги в `loginUser`.
- `signJwt(secret, { userId, email }) → string` — HS256, `iat/exp` (TTL 7 дней).

## Queries (db/)
- `findUserByEmail(db, email) → User | null` — `select … where email = ? limit 1` к таблице `users`.
- `insertUserIfFree(db, user) → boolean` — `insert into users … on conflict (email) do nothing returning id`. Возвращает `true`, если вставилось, `false` — если email уже занят.

## Ограничения

- **Нет публичного `routes` в `wrangler.jsonc`.** Воркер должен оставаться internal — все запросы только через gateway (CLAUDE.md → правило 11, антипаттерн «Internal-воркер с публичным `[[routes]]`»).
- **Нет JWT-middleware.** Auth не валидирует чужие токены, только подписывает свои (CLAUDE.md → правило 11).
- **Нет Workers AI и Vectorize биндингов.** Только `DB` и `JWT_SECRET`.
- **Email хранится в lower-case.** Все запросы к `users` идут через `findUserByEmail`, который ожидает уже нормализованный email.
- **Параметры Scrypt захардкожены.** Их изменение потребует rehash при следующем логине каждого пользователя — на старте не предусмотрено, при необходимости добавлять отдельным шагом.
- **Срок жизни JWT — 7 дней.** Refresh-токенов нет (out of scope F6 → продление сессии следующим шагом, см. business-requirements.md).
- **Нет rate-limit на `/login`.** Защита от перебора — задача gateway/CDN-уровня, не auth.
