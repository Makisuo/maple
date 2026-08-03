import { Effect, Layer, Schema } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { apiError, invalidRequest, V2SchemaErrors, V2UnexpectedErrors } from "@maple/domain/http/v2"
import { describeSchemaIssue } from "@/routes/schema-error-detail"

class V2RouteExecutionDefect extends Schema.TaggedErrorClass<V2RouteExecutionDefect>()(
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
	(schemaError) =>
		Effect.suspend(() => {
			const details = describeSchemaIssue(schemaError.cause.issue)
			const first = details[0]
			if (first === undefined) {
				return Effect.fail(
					invalidRequest("parameter_invalid", `Invalid request ${schemaError.kind.toLowerCase()}.`),
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
				),
			)
		}),
)

export const V2UnexpectedErrorsLive = Layer.succeed(
	V2UnexpectedErrors,
	V2UnexpectedErrors.of((httpEffect, { endpoint, group }) =>
		httpEffect.pipe(
			Effect.catchDefect((cause) => {
				const defectType = cause instanceof Error ? cause.name : typeof cause
				const error = new V2RouteExecutionDefect({
					group: group.identifier,
					operation: endpoint.name,
					message: "Unexpected v2 route execution defect",
					cause,
				})
				return Effect.logError(error.message).pipe(
					Effect.annotateLogs({
						errorTag: error._tag,
						group: error.group,
						operation: error.operation,
						defectType,
					}),
					Effect.andThen(Effect.fail(apiError())),
				)
			}),
		),
	),
)

/** Both cross-cutting v2 error middlewares; kept under the established layer name for harnesses. */
export const V2SchemaErrorsLive = Layer.merge(V2SchemaErrorTransformLive, V2UnexpectedErrorsLive)
