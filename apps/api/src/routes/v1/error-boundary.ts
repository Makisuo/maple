import { Effect, Layer, Schema } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import {
	V1RequestValidationError,
	V1SchemaErrors,
	V1UnexpectedError,
	V1UnexpectedErrors,
} from "@maple/domain/http"
import { describeSchemaIssue, summarizeSchemaError } from "@/routes/schema-error-detail"

class V1RouteExecutionDefect extends Schema.TaggedError<V1RouteExecutionDefect>()(
	"@maple/api/routes/v1/V1RouteExecutionDefect",
	{
		group: Schema.String,
		operation: Schema.String,
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

class V1ResponseSchemaError extends Schema.TaggedError<V1ResponseSchemaError>()(
	"@maple/api/routes/v1/V1ResponseSchemaError",
	{
		group: Schema.String,
		operation: Schema.String,
		component: Schema.Literals(["Body", "ResponseHeaders"]),
		message: Schema.String,
		details: Schema.Array(Schema.String),
		cause: Schema.Defect(),
	},
) {}

const V1SchemaErrorTransformLive = HttpApiMiddleware.layerSchemaErrorTransform(
	V1SchemaErrors,
	(schemaError, { endpoint, group }) =>
		Effect.suspend((): Effect.Effect<never, V1RequestValidationError | V1UnexpectedError> => {
			const details = describeSchemaIssue(schemaError.cause.issue)
			if (schemaError.kind === "Body" || schemaError.kind === "ResponseHeaders") {
				const error = new V1ResponseSchemaError({
					group: group.identifier,
					operation: endpoint.identifier,
					component: schemaError.kind,
					message: "V1 response failed its declared HTTP schema",
					details: details.map(({ line }) => line),
					cause: schemaError.cause,
				})
				return Effect.logError(error.message).pipe(
					Effect.annotateLogs({
						errorTag: error._tag,
						group: error.group,
						operation: error.operation,
						component: error.component,
						details: error.details,
						cause: error.cause,
					}),
					Effect.andThen(
						Effect.fail(
							new V1UnexpectedError({
								message: "An unexpected error occurred on our end.",
							}),
						),
					),
				)
			}
			const first = details[0]
			return Effect.fail(
				new V1RequestValidationError({
					message: summarizeSchemaError(schemaError.kind, details),
					...(first === undefined || first.path === "" ? {} : { param: first.path }),
					details: details.map(({ line }) => line),
				}),
			)
		}),
)

const V1UnexpectedErrorsLive = Layer.succeed(
	V1UnexpectedErrors,
	V1UnexpectedErrors.of((httpEffect, { endpoint, group }) =>
		httpEffect.pipe(
			Effect.catchDefect((cause) => {
				const defectType = cause instanceof Error ? cause.name : typeof cause
				const error = new V1RouteExecutionDefect({
					group: group.identifier,
					operation: endpoint.identifier,
					message: "Unexpected v1 route execution defect",
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
							new V1UnexpectedError({
								message: "An unexpected error occurred on our end.",
							}),
						),
					),
				)
			}),
		),
	),
)

/** API-wide legacy error boundary: useful 400s and sanitized, logged defects. */
export const V1ErrorBoundaryLive = Layer.merge(V1SchemaErrorTransformLive, V1UnexpectedErrorsLive)
