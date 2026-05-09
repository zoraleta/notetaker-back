import jwt from '@tsndr/cloudflare-worker-jwt'

// Подпись JWT — единственная JWT-операция, которая живёт в auth.
// Проверка токена выполняется в notetaker-api-gateway, во внутренние
// воркеры токен не доходит (gateway передаёт уже валидированный userId).

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 дней — см. F6 в business-requirements

export interface JwtPayload {
	userId: string
	email: string
}

export async function signJwt(secret: string, payload: JwtPayload): Promise<string> {
	const nowSeconds = Math.floor(Date.now() / 1000)
	return jwt.sign(
		{
			...payload,
			iat: nowSeconds,
			exp: nowSeconds + TOKEN_TTL_SECONDS,
		},
		secret,
	)
}
