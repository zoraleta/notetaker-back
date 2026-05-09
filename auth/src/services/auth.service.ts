import type { Env } from '../config/env'
import { findUserByEmail, insertUserIfFree } from '../db/users.queries'
import { signJwt } from '../lib/jwt'
import { err, ok, type Result } from '../lib/result'
import { hashPassword, verifyDummyPassword, verifyPassword } from './password.service'

export interface AuthInput {
	email: string
	password: string
}

export interface AuthSuccess {
	token: string
	user: {
		id: string
		email: string
	}
}

export async function registerUser(env: Env, input: AuthInput): Promise<Result<AuthSuccess>> {
	const email = normaliseEmail(input.email)
	const id = crypto.randomUUID()
	const passwordHash = await hashPassword(input.password)

	const inserted = await insertUserIfFree(env.DB, {
		id,
		email,
		passwordHash,
		createdAt: new Date(),
	})
	if (!inserted) {
		return err('Пользователь с таким email уже зарегистрирован', 'VALIDATION')
	}

	const token = await signJwt(env.JWT_SECRET, { userId: id, email })
	return ok({ token, user: { id, email } })
}

export async function loginUser(env: Env, input: AuthInput): Promise<Result<AuthSuccess>> {
	const email = normaliseEmail(input.email)
	const user = await findUserByEmail(env.DB, email)

	// Одинаковая ошибка для «нет пользователя» и «неверный пароль» —
	// чтобы не светить, существует ли email в БД (см. F6 → Edge cases).
	// Плюс гоняем dummy-verify в ветке !user, чтобы выровнять время
	// ответа и не дать enumeration через timing.
	if (!user) {
		await verifyDummyPassword(input.password)
		return err('Неверный email или пароль', 'UNAUTHORIZED')
	}

	const passwordMatches = await verifyPassword(input.password, user.passwordHash)
	if (!passwordMatches) {
		return err('Неверный email или пароль', 'UNAUTHORIZED')
	}

	const token = await signJwt(env.JWT_SECRET, { userId: user.id, email: user.email })
	return ok({ token, user: { id: user.id, email: user.email } })
}

// Email хранится и сравнивается в нижнем регистре, чтобы User@x.com и
// user@x.com считались одним пользователем.
function normaliseEmail(email: string): string {
	return email.trim().toLowerCase()
}
