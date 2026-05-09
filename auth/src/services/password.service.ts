import { scryptAsync } from '@noble/hashes/scrypt.js'
import { encodeBase64, decodeBase64 } from '@oslojs/encoding'

// Хеширование пароля через Scrypt (edge-совместимая, чистая JS-реализация
// из @noble/hashes — bcrypt/argon2 в Workers недоступны).
//
// Формат сохраняемого значения: "<saltBase64>:<hashBase64>".
// Параметры N/r/p/dkLen фиксированы; их изменение потребует rehash при
// следующем логине каждого пользователя.

const SCRYPT_PARAMS = { N: 1 << 14, r: 8, p: 1, dkLen: 64 } as const
const SALT_BYTES = 16
const HASH_DELIMITER = ':'

// Заранее посчитанный валидный хеш для anti-enumeration: при логине с
// несуществующим email мы всё равно прогоняем verifyPassword по этой
// «пустышке», чтобы время ответа совпадало со случаем неверного пароля
// (защита от timing oracle, раскрывающего наличие email в БД).
const DUMMY_HASH =
	'AAAAAAAAAAAAAAAAAAAAAA==:' +
	'D7w+vFr4i/QJ6vXcOiCs1ICm+xOLZ8gnE0BmkY4MMfMb6n5Lu9CC74r0nm/9p2nzPmkBYRblKNHiH4xFqVTQqQ=='

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
	const hash = await scryptAsync(password, salt, SCRYPT_PARAMS)
	return `${encodeBase64(salt)}${HASH_DELIMITER}${encodeBase64(hash)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [saltB64, hashB64] = stored.split(HASH_DELIMITER)
	if (!saltB64 || !hashB64) return false

	const salt = decodeBase64(saltB64)
	const expected = decodeBase64(hashB64)
	const actual = await scryptAsync(password, salt, SCRYPT_PARAMS)
	return constantTimeEqual(actual, expected)
}

// Сравнение за постоянное время — защита от timing-атак при подборе пароля.
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) {
		diff |= a[i]! ^ b[i]!
	}
	return diff === 0
}

// Прогоняет Scrypt против пустышки — нужен только в loginUser, чтобы выровнять
// время ответа на «нет такого пользователя» и «неверный пароль».
export async function verifyDummyPassword(password: string): Promise<void> {
	await verifyPassword(password, DUMMY_HASH)
}
