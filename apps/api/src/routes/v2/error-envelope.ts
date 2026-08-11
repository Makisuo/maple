import { Effect, Layer, Schema } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { HttpEffect, HttpServerResponse } from "effect/unstable/http"
import { apiError, invalidRequest, V2SchemaErrors, V2UnexpectedErrors } from "@maple/domain/http/v2"
import { describeSchemaIssue } from "@/routes/schema-error-detail"

class V2RouteExecutionDefect extends Schema.TaggedError<V2RouteExecutionDefect>()(
	"@maple/api/routes/v2/V2RouteExecutionDefect",
	{
		group: Schema.String,
		operation: Schema.String,
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/**
 * Request-decode failures (params/query/payload) under /v2 are rewritten into
 * the v2 error envelope — `{ "error": { "type": "invalid_request_error",
 * "code": "parameter_invalid", "message": … } }` — instead of the runtime's
 * default empty 400 (see docs/api-v2.md#errors).
 *
 * `param` carries the full JSON path (`widgets[3].display.fill_nulls`), not
 * just its first segment, and the message names the enclosing widget when the
 * path points inside a `widgets[]` array — the envelope holds one error, so a
 * document with several bad fields reports the first and counts the rest.
 */
const V2SchemaErrorTransformLive = HttpApiMiddleware.layerSchemaErrorTransform(
	V2SchemaErrors,
	(schemaError, { endpoint, group }) =>
		Effect.suspend(() => {
			const metadata = {
				tag: `@maple/http/v2/${group.identifier}/${endpoint.identifier}/InvalidRequestError`,
			} as const
			const details = describeSchemaIssue(schemaError.cause.issue)
			const first = details[0]
			if (first === undefined) {
				return Effect.fail(
					invalidRequest(
						"parameter_invalid",
						`Invalid request ${schemaError.kind.toLowerCase()}.`,
						undefined,
						metadata,
					),
				)
			}
			const remaining = details.length - 1
			const suffix =
				remaining === 0
					? ""
					: ` (and ${remaining} other invalid ${remaining === 1 ? "field" : "fields"})`
			return Effect.fail(
				invalidRequest(
					"parameter_invalid",
					`${first.line}${suffix}`,
					first.path === "" ? undefined : first.path,
					metadata,
				),
			)
		}),
)

const retryAfterHeader = (failure: unknown): string | undefined => {
	if (typeof failure !== "object" || failure === null || !("error" in failure)) return undefined
	const error = (failure as { readonly error: unknown }).error
	if (typeof error !== "object" || error === null) return undefined
	if ("retry_after_seconds" in error && typeof error.retry_after_seconds === "number") {
		return String(Math.max(1, Math.ceil(error.retry_after_seconds)))
	}
	if ("retry_at" in error && typeof error.retry_at === "string") {
		const retryAt = new Date(error.retry_at)
		if (Number.isFinite(retryAt.getTime())) return retryAt.toUTCString()
	}
	return undefined
}

const appendRetryAfter = (failure: unknown) => {
	const value = retryAfterHeader(failure)
	if (value === undefined) return Effect.void
	return HttpEffect.appendPreResponseHandler((_request, response) =>
		Effect.succeed(HttpServerResponse.setHeader(response, "Retry-After", value)),
	)
}

export const V2UnexpectedErrorsLive = Layer.succeed(
	V2UnexpectedErrors,
	V2UnexpectedErrors.of((httpEffect, { endpoint, group }) =>
		httpEffect.pipe(
			Effect.tapError(appendRetryAfter),
			Effect.catchDefect((cause) => {
				const defectType = cause instanceof Error ? cause.name : typeof cause
				const error = new V2RouteExecutionDefect({
					group: group.identifier,
					operation: endpoint.identifier,
					message: "Unexpected v2 route execution defect",
					cause,
				})
				return Effect.logError(error.message).pipe(
					Effect.annotateLogs({
						errorTag: error._tag,
						group: error.group,
						operation: error.operation,
						defectType,
						cause: error.cause,
					}),
					Effect.andThen(
						Effect.fail(
							apiError({
								tag: `@maple/http/v2/${group.identifier}/${endpoint.identifier}/UnexpectedError`,
							}),
						),
					),
				)
			}),
		),
	),
)

/** Both cross-cutting v2 error middlewares; kept under the established layer name for harnesses. */
export const V2SchemaErrorsLive = Layer.merge(V2SchemaErrorTransformLive, V2UnexpectedErrorsLive)
