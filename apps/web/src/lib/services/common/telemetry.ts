import { Effect } from "effect"
import { runtime } from "./runtime"

const requestUrl = (input: RequestInfo | URL): string =>
	typeof input === "string"
		? input
		: input instanceof URL
			? input.href
			: input.url

export const tracedFetch = (
	peerService: string,
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> => {
	const url = requestUrl(input)
	const parsed = new URL(url, window.location.href)
	const method =
		init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")

	return runtime.runPromise(
		Effect.gen(function* () {
			const span = yield* Effect.currentSpan
			const headers = new Headers(
				init?.headers ??
					(typeof Request !== "undefined" && input instanceof Request
						? input.headers
						: undefined),
			)
			if (!headers.has("traceparent")) {
				headers.set("traceparent", `00-${span.traceId}-${span.spanId}-01`)
			}
			const response = yield* Effect.tryPromise({
				try: () => globalThis.fetch(input, { ...init, headers }),
				catch: (cause) => cause,
			})
			yield* Effect.annotateCurrentSpan(
				"http.response.status_code",
				response.status,
			)
			return response
		}).pipe(
			Effect.withSpan("http.client", {
				kind: "client",
				attributes: {
					"http.request.method": method,
					"url.full": parsed.href,
					"server.address": parsed.hostname,
					"peer.service": peerService,
				},
			}),
		),
	)
}

export const logClientError = (
	message: string,
	error: unknown,
	attributes: Record<string, string | number | boolean> = {},
): void => {
	runtime.runFork(
		Effect.logError(message).pipe(
			Effect.annotateLogs({
				...attributes,
				"error.type": error instanceof Error ? error.name : "UnknownError",
				"error.message": error instanceof Error ? error.message : String(error),
			}),
		),
	)
}

export const logClientWarning = (
	message: string,
	error: unknown,
	attributes: Record<string, string | number | boolean> = {},
): void => {
	runtime.runFork(
		Effect.logWarning(message).pipe(
			Effect.annotateLogs({
				...attributes,
				"error.type": error instanceof Error ? error.name : "UnknownError",
				"error.message": error instanceof Error ? error.message : String(error),
			}),
		),
	)
}
