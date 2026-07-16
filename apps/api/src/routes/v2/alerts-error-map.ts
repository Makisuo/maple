import type {
	AlertDestinationInUseError,
	AlertForbiddenError,
	AlertNotFoundError,
	AlertValidationError,
} from "@maple/domain/http"
import type {
	V2ConflictError,
	V2InvalidRequestError,
	V2NotFoundError,
	V2PermissionError,
	V2ServiceUnavailableError,
} from "@maple/domain/http/v2"
import { conflict, invalidRequest, notFound, permissionError, serviceUnavailable } from "@maple/domain/http/v2"

/**
 * v1 alerts service errors → v2 envelope errors, precisely typed: the result
 * union only contains the envelope errors the *input* union can actually
 * produce, so handlers whose endpoints declare fewer error responses still
 * typecheck. Anything unrecognized (persistence, delivery, warehouse) maps to
 * `service_unavailable`.
 */
export type MappedV2AlertError<E> =
	| (E extends AlertForbiddenError ? V2PermissionError : never)
	| (E extends AlertValidationError ? V2InvalidRequestError : never)
	| (E extends AlertNotFoundError ? V2NotFoundError : never)
	| (E extends AlertDestinationInUseError ? V2ConflictError : never)
	| V2ServiceUnavailableError

const errorMessage = (error: object): string =>
	"message" in error && typeof error.message === "string"
		? error.message
		: "The service is temporarily unavailable; retry after a short delay."

export const mapAlertError = <E extends { readonly _tag: string }>(error: E): MappedV2AlertError<E> => {
	switch (error._tag) {
		case "@maple/http/errors/AlertForbiddenError":
			return permissionError("insufficient_permissions", errorMessage(error)) as MappedV2AlertError<E>
		case "@maple/http/errors/AlertValidationError":
			return invalidRequest("parameter_invalid", errorMessage(error)) as MappedV2AlertError<E>
		case "@maple/http/errors/AlertNotFoundError":
			return notFound(errorMessage(error), "id") as MappedV2AlertError<E>
		case "@maple/http/errors/AlertDestinationInUseError":
			return conflict("resource_in_use", errorMessage(error)) as MappedV2AlertError<E>
		default:
			return serviceUnavailable(errorMessage(error)) as MappedV2AlertError<E>
	}
}
