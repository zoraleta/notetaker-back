// Result<T> — копия из notes/auth (CLAUDE.md разрешает копирование общих
// типов между воркерами вместо общего npm-пакета). При расхождении —
// синхронизировать вручную.
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
