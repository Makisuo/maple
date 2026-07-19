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

type UpstreamMappedWarehouseError = Exclude<
	WarehouseError,
	WarehouseValidationError | WarehouseQuotaExceededError | WarehouseUpstreamError
>

type MappedV2AlertError<E> =
	| (E extends AlertForbiddenError ? V2PermissionError : never)
	| (E extends AlertValidationError | WarehouseValidationError ? V2InvalidRequestError : never)
	| (E extends AlertNotFoundError ? V2NotFoundError : never)
	| (E extends AlertDestinationInUseError ? V2ConflictError : never)
	| (E extends WarehouseQuotaExceededError ? V2RateLimitError : never)
	| (E extends WarehouseUpstreamError ? V2ServiceUnavailableError : never)
	| (E extends AlertDeliveryError | UpstreamMappedWarehouseError ? V2UpstreamError : never)
	| (E extends AlertPersistenceError ? V2ServiceUnavailableError : never)

const normalizeAlertResourceType = (resourceType: string) =>
	Match.value(resourceType).pipe(
		Match.when("destination", () => "alert_destination"),
		Match.when("rule", () => "alert_rule"),
		Match.when("alert_incident", () => "alert_incident"),
		Match.when("alert_rule", () => "alert_rule"),
		Match.orElse(() => "alert_resource"),
	)

const makeAlertErrorMatcher = (operation: string) => {
	const warehouseFailure = () =>
		upstreamError(`alert_${operation}_upstream_failed`, "The alert query could not be completed.")
	return Match.type<V2ReachableAlertError>().pipe(
		Match.tagsExhaustive({
			"@maple/http/errors/AlertForbiddenError": () =>
				permissionError(
					"insufficient_permissions",
					"You do not have permission to perform this alert operation.",
				),
			"@maple/http/errors/AlertValidationError": (error) =>
				invalidRequest("parameter_invalid", error.message),
			"@maple/http/errors/AlertNotFoundError": (error) => {
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
			// A quota breach is the caller exceeding cost limits (429), and a
			// validation failure is a malformed request (400) — neither is an
			// upstream outage.
			"@maple/http/errors/WarehouseQuotaExceededError": () => rateLimited(),
			"@maple/http/errors/WarehouseValidationError": (error) =>
				invalidRequest("parameter_invalid", error.message),
		}),
	)
}

/** Exhaustive, tag-local v1 alert error translation for v2 handlers. */
export const mapAlertError = (operation: string) => {
	const match = makeAlertErrorMatcher(operation)
	return <A, E extends V2ReachableAlertError, R>(
		effect: Effect.Effect<A, E, R>,
	): Effect.Effect<A, MappedV2AlertError<E>, R> =>
		effect.pipe(Effect.mapError((error) => match(error) as MappedV2AlertError<E>))
}
