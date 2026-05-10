export type ResultErrorCode =
	| 'NOT_FOUND'
	| 'FORBIDDEN'
	| 'VALIDATION'
	| 'UNAUTHORIZED'
	| 'EXTERNAL'

export type Result<T> =
	| { ok: true; data: T }
	| { ok: false; error: string; code: ResultErrorCode }

export const ok = <T>(data: T): Result<T> => ({ ok: true, data })

export const err = <T = never>(error: string, code: ResultErrorCode): Result<T> => ({
	ok: false,
	error,
	code,
})
