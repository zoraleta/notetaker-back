import type { Env } from '../config/env'
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../config/ai-models'

// Эмбеддинг текста через Workers AI bge-m3. Единственное место в воркере,
// которое зовёт env.AI.run(EMBEDDING_MODEL): и upsert, и query, и discuss
// (RAG в Phase 5G) идут сюда. Embedding-модель — константа (CLAUDE.md →
// «Векторный индекс»: смена = новый Vectorize-индекс).
//
// Возвращает Float32-вектор длины EMBEDDING_DIMENSIONS (1024 для bge-m3).

export interface EmbedResponse {
	shape: number[]
	data: number[][]
}

export async function embedText(env: Env, text: string): Promise<number[]> {
	// Workers AI bge-m3 принимает массив строк, возвращает массив векторов;
	// для одной строки берём первый и единственный.
	const response = (await env.AI.run(EMBEDDING_MODEL, { text: [text] })) as EmbedResponse
	const vector = response.data[0]
	if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
		// Несоответствие размерности = ошибка контракта Workers AI или индекса.
		// Поднимаем в onError → 500, но логируем фактическую длину для дебага.
		throw new Error(
			`bge-m3 returned ${vector?.length ?? 0} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
		)
	}
	return vector
}
