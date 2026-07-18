import { Array as Arr, Effect, Layer, Option, Schema, SchemaIssue } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { apiError, invalidRequest, V2SchemaErrors, V2UnexpectedErrors } from "@maple/domain/http/v2"

class V2RouteExecutionDefect extends Schema.TaggedErrorClass<V2RouteExecutionDefect>()(
	"@maple/api/routes/v2/V2RouteExecutionDefect",
	{
		group: Schema.String,
		operation: Schema.String,
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

const formatSchemaIssue = SchemaIssue.makeFormatterStandardSchemaV1()

/**
 * Request-decode failures (params/query/payload) under /v2 are rewritten into
 * the v2 error envelope — `{ "error": { "type": "invalid_request_error",
 * "code": "parameter_invalid", "message": … } }` — instead of the runtime's
 * default empty 400 (see docs/api-v2.md#errors).
 */
const V2SchemaErrorTransformLive = HttpApiMiddleware.layerSchemaErrorTransform(
	V2SchemaErrors,
	(schemaError) =>
		Effect.sync(() => formatSchemaIssue(schemaError.cause.issue)).pipe(
			Effect.flatMap(({ issues }) => {
				const issue = Arr.head(issues)
				const firstPath = Option.flatMap(issue, ({ path }) =>
					Option.flatMap(Option.fromNullishOr(path), Arr.head),
				)
				const param = Option.getOrUndefined(
					Option.filter(
						firstPath,
						(value) => typeof value === "string" || typeof value === "number",
					).pipe(Option.map(String)),
				)
				const message = Option.getOrElse(
					Option.map(issue, ({ message }) => message),
					() => `Invalid request ${schemaError.kind.toLowerCase()}.`,
				)
				return Effect.fail(invalidRequest("parameter_invalid", message, param))
			}),
		),
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
