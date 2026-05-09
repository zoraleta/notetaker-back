// Cast результатa `env.AI.run(model, { stream: true })` в типизированный
// ReadableStream. Workers-types не различают overload по флагу `stream`
// (фиксированный output type `AiTextGenerationOutput`), но фактический
// рантайм всегда возвращает Web `ReadableStream` с SSE-форматом. Каст
// через `unknown` — единственный способ примирить типы без any.
//
// Помещено в shared lib, потому что используется в `summarize.service` и
// `discuss.service` (Phase 5D, 5G); следующий стрим-эндпоинт получит helper
// бесплатно, без копирования комментария.
export function toReadableStream(result: unknown): ReadableStream<Uint8Array> {
	return result as unknown as ReadableStream<Uint8Array>
}
