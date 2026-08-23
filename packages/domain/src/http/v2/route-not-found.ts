import { publicHttpErrorBody } from "../error-policy"
import { defineV2Error } from "./errors"

/**
 * The envelope for a request that matched no route at all — the one failure
 * that happens *outside* every `HttpApi` group, so no endpoint schema owns it.
 * The API mounts a lowest-precedence catch-all that fails with this, so an
 * agent probing `/v2/typo` gets the same `{ error: { … } }` shape as every
 * other v2 failure instead of an empty 404.
 */
export const V2RouteNotFound = defineV2Error({
	tag: "@maple/http/v2/RouteNotFoundError",
	status: 404,
	code: "route_not_found",
	title: "No such route",
	message: "No route matches this method and path.",
	retry: "never",
	recovery: "fix_request",
	identifier: "RouteNotFoundError",
})

export interface RouteNotFoundHints {
	/** Absolute URL of the machine-readable OpenAPI document. */
	readonly openApiUrl: string
	/** Absolute URL of the human-readable API reference. */
	readonly docsUrl: string
}

/**
 * Build the wire body for an unmatched `method path`. The message names the
 * request so a log line or an agent transcript is self-explanatory, and points
 * at the spec and docs so the caller can recover without guessing URLs.
 */
export const v2RouteNotFoundBody = (method: string, path: string, hints: RouteNotFoundHints) =>
	publicHttpErrorBody(
		V2RouteNotFound.make(
			`No route matches ${method.toUpperCase()} ${path}. The Maple API is documented at ${hints.docsUrl}; the OpenAPI specification is at ${hints.openApiUrl}.`,
		),
	)
