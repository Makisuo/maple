import { Schema } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

/**
 * Uniform request-decode failure for the legacy `/api` HttpApi.
 *
 * v1 keeps its established top-level tagged-error wire format, but malformed
 * params, query strings, headers, and payloads must still return a useful JSON
 * body instead of Effect's default empty 400 response.
 */
export class V1RequestValidationError extends Schema.TaggedError<V1RequestValidationError>()(
	"@maple/http/v1/V1RequestValidationError",
	{
		message: Schema.String,
		param: Schema.optionalKey(Schema.String),
		details: Schema.Array(Schema.String),
	},
	{ httpApiStatus: 400 },
) {}

/** Sanitized response for an unexpected defect in a legacy HttpApi handler. */
export class V1UnexpectedError extends Schema.TaggedError<V1UnexpectedError>()(
	"@maple/http/v1/V1UnexpectedError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 500 },
) {}

/** Rewrites request/response schema failures for every v1 HttpApi endpoint. */
export class V1SchemaErrors extends HttpApiMiddleware.Service<V1SchemaErrors>()("V1SchemaErrors", {
	error: [V1RequestValidationError, V1UnexpectedError],
}) {}

/** Converts unexpected handler defects into a logged, sanitized v1 response. */
export class V1UnexpectedErrors extends HttpApiMiddleware.Service<V1UnexpectedErrors>()(
	"V1UnexpectedErrors",
	{ error: V1UnexpectedError },
) {}
