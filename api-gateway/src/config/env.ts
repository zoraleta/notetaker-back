// JWT_SECRET должен совпадать со значением в notetaker-auth: auth подписывает
// токен этим секретом, gateway проверяет тем же. Service Bindings будут
// добавляться по мере появления internal-воркеров (Phase 4–7).
export interface Env {
	JWT_SECRET: string
	AUTH: Fetcher
	NOTES: Fetcher
	AI: Fetcher
}

export type Variables = {
	user: {
		id: string
		email: string
	}
}

export type AppBindings = {
	Bindings: Env
	Variables: Variables
}
