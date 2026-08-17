import {
	v2WorkerUnavailableBody,
	v2WorkerUnavailableDefinition,
} from "@maple/domain/http/v2-worker-unavailable"

/** Canonical v2 fallback used when the route graph could not finish bootstrapping. */
export const v2WorkerUnavailableResponse = (): Response => {
	const definition = v2WorkerUnavailableDefinition
	return Response.json(
		{ error: v2WorkerUnavailableBody() },
		{
			status: definition.status,
			headers: { "retry-after": String(definition.retryAfterSeconds) },
		},
	)
}
