import { Effect } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { invalidRequest, V2SchemaErrors } from "@maple/domain/http/v2"

/**
 * Request-decode failures (params/query/payload) under /v2 are rewritten into
 * the v2 error envelope — `{ "error": { "type": "invalid_request_error",
 * "code": "parameter_invalid", "message": … } }` — instead of the runtime's
 * default empty 400 (see docs/api-v2.md#errors).
 */
export const V2SchemaErrorsLive = HttpApiMiddleware.layerSchemaErrorTransform(
	V2SchemaErrors,
	(schemaError) =>
		Effect.fail(
			invalidRequest(
				"parameter_invalid",
				`Invalid request ${schemaError.kind.toLowerCase()}: ${schemaError.cause.message}`,
			),
		),
)
