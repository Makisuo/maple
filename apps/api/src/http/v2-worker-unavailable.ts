import type { AnyPublicHttpErrorBody } from "@maple/domain/http"

/** Canonical v2 fallback used when the route graph could not finish bootstrapping. */
export const v2WorkerUnavailableResponse = (): Response => {
	const error = {
		_tag: "@maple/http/v2/WorkerUnavailableError",
		type: "api_error",
		code: "worker_unavailable",
		title: "Maple API is temporarily unavailable",
		message: "Maple API is temporarily unavailable. Retry in a few seconds.",
		retryable: true,
		recovery: "retry",
		retry_after_seconds: 1,
	} as const satisfies AnyPublicHttpErrorBody
	return Response.json({ error }, { status: 504, headers: { "retry-after": "1" } })
}
