import type {
	AlertDeliveryError,
	AlertDestinationInUseError,
	AlertForbiddenError,
	AlertNotFoundError,
	AlertPersistenceError,
	AlertValidationError,
	WarehouseError,
	WarehouseQuotaExceededError,
	WarehouseUpstreamError,
	WarehouseValidationError,
} from "@maple/domain/http"
import { presentWarehouseErrorPublic, type WarehouseErrorLike } from "@maple/domain/http"
import {
	conflict,
	dependencyUnavailable,
	invalidRequest,
	permissionError,
	rateLimited,
	resourceNotFound,
	upstreamError,
} from "@maple/domain/http/v2"
import type {
	V2ConflictError,
	V2InvalidRequestError,
	V2NotFoundError,
	V2PermissionError,
	V2RateLimitError,
	V2ServiceUnavailableError,
	V2UpstreamError,
} from "@maple/domain/http/v2"
import { Effect, Match } from "effect"

type V2ReachableAlertError =
	| AlertForbiddenError
	| AlertValidationError
	| AlertNotFoundError
	| AlertDestinationInUseError
	| AlertPersistenceError
	| AlertDeliveryError
	| WarehouseError

type V2AlertReadError = V2InvalidRequestError | V2RateLimitError | V2ServiceUnavailableError

type V2AlertCommonError = V2AlertReadError | V2UpstreamError

type V2AlertWriteError = V2AlertCommonError | V2PermissionError

type V2AlertMutationError = V2AlertWriteError | V2NotFoundError

type V2AlertMappedError = V2AlertMutationError | V2ConflictError | V2RateLimitError

const normalizeAlertResourceType = (resourceType: string) =>
	Match.value(resourceType).pipe(
		Match.when("destination", () => "alert_destination"),
		Match.when("rule", () => "alert_rule"),
		Match.when("alert_incident", () => "alert_incident"),
		Match.when("alert_rule", () => "alert_rule"),
		Match.orElse(() => "alert_resource"),
	)

const makeAlertErrorMatcher = (operation: string) => {
	// Forward the shared per-tag copy instead of one fixed string: a missing
	// column on the customer's cluster and a Maple SQL bug used to be
	// indistinguishable "The alert query could not be completed." envelopes.
	// Redacted presentation: raw ClickHouse diagnostics stay off the public API.
	const warehouseFailure = (error: WarehouseErrorLike) =>
		upstreamError(`alert_${operation}_upstream_failed`, presentWarehouseErrorPublic(error).description)
	return Match.type<V2ReachableAlertError>().pipe(
		Match.tagsExhaustive({
			"@maple/http/errors/AlertForbiddenError": () =>
				permissionError(
					"insufficient_permissions",
					"You do not have permission to perform this alert operation.",
				),
			"@maple/http/errors/AlertValidationError": (error: AlertValidationError) =>
				invalidRequest("parameter_invalid", error.message),
			"@maple/http/errors/AlertNotFoundError": (error: AlertNotFoundError) => {
				const resource = normalizeAlertResourceType(error.resourceType)
				return resourceNotFound(resource, `No such ${resource.replaceAll("_", " ")}.`)
			},
			"@maple/http/errors/AlertDestinationInUseError": () =>
				conflict(
					"alert_destination_in_use",
					"The alert destination is currently used by one or more alert rules.",
				),
			"@maple/http/errors/AlertPersistenceError": () =>
				dependencyUnavailable(`alert_${operation}_unavailable`),
			"@maple/http/errors/AlertDeliveryError": () =>
				upstreamError(`alert_${operation}_upstream_failed`, "The alert provider request failed."),
			"@maple/http/errors/WarehouseQueryError": warehouseFailure,
			"@maple/http/errors/WarehouseUpstreamError": () =>
				dependencyUnavailable(`alert_${operation}_unavailable`),
			"@maple/http/errors/WarehouseAuthError": warehouseFailure,
			"@maple/http/errors/WarehouseConfigError": warehouseFailure,
			"@maple/http/errors/WarehouseClientError": warehouseFailure,
			"@maple/http/errors/WarehouseSchemaDriftError": warehouseFailure,
			// Maple generated SQL its own warehouse refused to plan: a server fault,
			// not the caller's, so it stays a 5xx rather than becoming a 400 — but
			// under its own code so on-call stops chasing the customer's warehouse.
			"@maple/http/errors/WarehouseMalformedQueryError": (error: WarehouseErrorLike) =>
				upstreamError(`alert_${operation}_query_bug`, presentWarehouseErrorPublic(error).description),
			// A quota breach is the caller exceeding cost limits (429), and a
			// validation failure is a malformed request (400) — neither is an
			// upstream outage.
			"@maple/http/errors/WarehouseQuotaExceededError": () => rateLimited(),
			"@maple/http/errors/WarehouseValidationError": (error: WarehouseValidationError) =>
				invalidRequest("parameter_invalid", error.message),
		}),
	)
}

/** Exhaustive, tag-local v1 alert error translation for v2 handlers. */
export function mapAlertError(
	operation: "delivery_list" | "incident_list",
): <A, E extends V2ReachableAlertError, R>(
	effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, V2AlertReadError, R>
export function mapAlertError(
	operation: "incident_retrieve",
): <A, E extends V2ReachableAlertError, R>(
	effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, V2AlertReadError | V2NotFoundError, R>
export function mapAlertError(
	operation: "destination_list" | "rule_list",
): <A, E extends V2ReachableAlertError, R>(
	effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, V2AlertCommonError, R>
export function mapAlertError(
	operation:
		| "destination_update"
		| "destination_test"
		| "rule_create"
		| "rule_update"
		| "rule_delete"
		| "rule_test",
): <A, E extends V2ReachableAlertError, R>(
	effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, V2AlertMutationError, R>
export function mapAlertError(
	operation: "destination_create",
): <A, E extends V2ReachableAlertError, R>(
	effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, V2AlertWriteError, R>
export function mapAlertError(
	operation: "destination_delete",
): <A, E extends V2ReachableAlertError, R>(
	effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, V2AlertMutationError | V2ConflictError, R>
export function mapAlertError(
	operation: "rule_preview" | "rule_checks_list",
): <A, E extends V2ReachableAlertError, R>(
	effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, V2AlertCommonError | V2NotFoundError, R>
export function mapAlertError(operation: string) {
	const match = makeAlertErrorMatcher(operation)
	return <A, E extends V2ReachableAlertError, R>(
		effect: Effect.Effect<A, E, R>,
	): Effect.Effect<A, V2AlertMappedError, R> => effect.pipe(Effect.mapError(match))
}
