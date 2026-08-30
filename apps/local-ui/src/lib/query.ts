// SPA-side wrapper around the shared `executeLocalQuery` client. The shared
// client (`@maple/query-engine/local`) is environment-agnostic and takes an
// explicit base URL; here we resolve it from the page origin so the same build
// works whether it's served same-origin by the binary (`--offline` / dev proxy)
// or remotely from `local.maple.dev`. Hooks import `executeLocalQuery` from here
// instead of the shared package so they never have to thread the base URL.
import { executeLocalQuery as run } from "@maple/query-engine/local"
import type { CompiledQuery, CompiledQueryInput } from "@maple/query-engine/ch"
import { Effect, type Option } from "effect"
import { localApiBase } from "./constants"

function executeLocalQuery<T = Record<string, unknown>>(sql: string, signal?: AbortSignal): Promise<T[]> {
	return run<T>(sql, localApiBase(), signal)
}

/**
 * `CH.compile` is Effect-returning now, so hooks hand us the effect — the same
 * `CompiledQueryInput` the API's executor takes. Resolving it here rather than
 * at ~150 call sites keeps every hook a one-liner, and a compile failure
 * rejects the promise the same way a query failure does, which is what a hook
 * already handles.
 */
const resolve = <T>(compiled: CompiledQueryInput<T>): Promise<CompiledQuery<T>> =>
	Effect.isEffect(compiled) ? Effect.runPromise(compiled) : Promise.resolve(compiled)

export async function executeLocalCompiledQuery<T>(
	compiled: CompiledQueryInput<T>,
	signal?: AbortSignal,
): Promise<ReadonlyArray<T>> {
	const query = await resolve(compiled)
	const rows = await executeLocalQuery(query.sql, signal)
	return Effect.runPromise(query.decodeRows(rows))
}

export async function executeLocalCompiledFirstRow<T>(
	compiled: CompiledQueryInput<T>,
	signal?: AbortSignal,
): Promise<Option.Option<T>> {
	const query = await resolve(compiled)
	const rows = await executeLocalQuery(query.sql, signal)
	return Effect.runPromise(query.decodeFirstRow(rows))
}
