import { Match } from "effect"
import {
	presentWarehouseErrorPublic,
	warehouseErrorMeta,
	type QueryEngineExecutionError,
	type QueryEngineTimeoutError,
	type QueryEngineValidationError,
	type WarehouseError,
} from "@maple/domain/http"
import { dependencyUnavailable, invalidRequest, rateLimited, upstreamError } from "@maple/domain/http/v2"
import type {
	V2InvalidRequestError,
	V2RateLimitError,
	V2ServiceUnavailableError,
	V2UpstreamError,
} from "@maple/domain/http/v2"

export type V2WarehouseError =
	| V2InvalidRequestError
	| V2RateLimitError
	| V2ServiceUnavailableError
	| V2UpstreamError

export type QueryEngineRouteError =
	| QueryEngineValidationError
	| QueryEngineExecutionError
	| QueryEngineTimeoutError
	| WarehouseError

/**
 * Exhaustive warehouse → v2 envelope translation for public telemetry-style
 * endpoints. Replaces the blanket `() => dependencyUnavailable(...)` lambdas
 * that mapped all nine warehouse tags — including 400 validation failures and
 * 429 quota breaches — to one fixed 503, so an API user sending a bad time
 * range was told the service was down.
 *
 * Statuses follow `httpApiStatus` on the error classes: 400 → invalid_request,
 * 429 → rate_limited, 503 (retryable outage) → `${operation}_unavailable`,
 * everything else → 502 with the tag's stable meta code and shared copy.
 *
 * Messages use the REDACTED presentation: raw ClickHouse diagnostics never
 * cross the public API boundary (pinned by telemetry.http.test.ts).
 */
export const warehouseToV2 = (operation: string): ((error: WarehouseError) => V2WarehouseError) => {
	const fault = (error: WarehouseError): V2WarehouseError =>
		upstreamError(warehouseErrorMeta[error._tag].code, presentWarehouseErrorPublic(error).description)
	return Match.type<WarehouseError>().pipe(
		Match.tagsExhaustive({
			"@maple/http/errors/WarehouseValidationError": (error) =>
				invalidRequest("parameter_invalid", error.message),
			"@maple/http/errors/WarehouseQuotaExceededError": () => rateLimited(),
			"@maple/http/errors/WarehouseUpstreamError": () =>
				dependencyUnavailable(`${operation}_unavailable`),
			"@maple/http/errors/WarehouseQueryError": fault,
			"@maple/http/errors/WarehouseAuthError": fault,
			"@maple/http/errors/WarehouseConfigError": fault,
			"@maple/http/errors/WarehouseClientError": fault,
			"@maple/http/errors/WarehouseSchemaDriftError": fault,
			"@maple/http/errors/WarehouseMalformedQueryError": fault,
		}),
	)
}

/**
 * Query-engine aggregation endpoints add validation, execution, and timeout
 * failures around the warehouse union. Keep that distinction at the public
 * boundary instead of inferring it from a tag substring and flattening every
 * other failure to 503.
 */
export const queryEngineToV2 = (operation: string): ((error: QueryEngineRouteError) => V2WarehouseError) => {
	const warehouse = warehouseToV2(operation)
	return Match.type<QueryEngineRouteError>().pipe(
		Match.tagsExhaustive({
			"@maple/http/errors/QueryEngineValidationError": () =>
				invalidRequest(`${operation}_invalid`, "The aggregation request is invalid.", "aggregation"),
			"@maple/http/errors/QueryEngineExecutionError": () =>
				upstreamError(`${operation}_failed`, "The aggregation query could not be completed."),
			"@maple/http/errors/QueryEngineTimeoutError": () =>
				dependencyUnavailable(`${operation}_unavailable`),
			"@maple/http/errors/WarehouseValidationError": warehouse,
			"@maple/http/errors/WarehouseQuotaExceededError": warehouse,
			"@maple/http/errors/WarehouseUpstreamError": warehouse,
			"@maple/http/errors/WarehouseQueryError": warehouse,
			"@maple/http/errors/WarehouseAuthError": warehouse,
			"@maple/http/errors/WarehouseConfigError": warehouse,
			"@maple/http/errors/WarehouseClientError": warehouse,
			"@maple/http/errors/WarehouseSchemaDriftError": warehouse,
			"@maple/http/errors/WarehouseMalformedQueryError": warehouse,
		}),
	)
}
