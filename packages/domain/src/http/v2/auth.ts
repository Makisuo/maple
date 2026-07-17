import { HttpApiMiddleware, HttpApiSecurity, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Context } from "../current-tenant"
import { V2AuthenticationError, V2InvalidRequestError, V2PermissionError } from "./errors"

/**
 * v2 bearer authorization. Same credential resolution as v1 (`maple_ak_…` API
 * key, else Clerk/self-hosted session token) but errors use the v2 envelope
 * and API keys are subject to scope enforcement (see docs/api-v2.md#scopes).
 *
 * Note: the error option must stay a *list* of classes (not `Schema.Union`) so
 * each error keeps its own `httpApiStatus` when responses are encoded.
 */
export class AuthorizationV2 extends HttpApiMiddleware.Service<
	AuthorizationV2,
	{
		provides: Context
	}
>()("AuthorizationV2", {
	error: [V2AuthenticationError, V2PermissionError],
	security: {
		bearer: HttpApiSecurity.bearer.pipe(
			HttpApiSecurity.annotateMerge(
				OpenApi.annotations({
					description:
						"Authenticate every request with a Bearer token: `Authorization: Bearer <token>`. Accepts a Maple API key (`maple_ak_…`) or a dashboard session token (Clerk / self-hosted JWT). API keys may be restricted with scopes — see the `Scope` schema.",
					format: "maple_ak_… API key or session JWT",
				}),
			),
		),
	},
}) {}

/**
 * Rewrites request-decode failures (params/query/payload schema errors) into
 * the v2 `invalid_request_error` envelope. Implemented in apps/api via
 * `HttpApiMiddleware.layerSchemaErrorTransform`; every v2 group must attach it.
 */
export class V2SchemaErrors extends HttpApiMiddleware.Service<V2SchemaErrors>()("V2SchemaErrors", {
	error: V2InvalidRequestError,
}) {}

/** Scope string grammar: `<family>:read`, `<family>:write`, or `*`. */
export const V2Scope = Schema.String.check(
	Schema.isPattern(/^([a-z][a-z0-9_]*:(read|write)|\*)$/, {
		description: 'scope like "dashboards:read", "alerts:write", or "*"',
	}),
).annotate({
	identifier: "Scope",
	title: "Scope",
	description:
		"Permission grant on a restricted API key. Grammar: `<family>:read`, `<family>:write`, or `*` (all). The family is the first path segment under `/v2` (e.g. `api_keys`, `dashboards`, `alert_rules`). `write` implies `read`; a key with no scopes has full access.",
	examples: ["api_keys:read", "dashboards:write", "*"],
})
export type V2Scope = Schema.Schema.Type<typeof V2Scope>

export interface RequiredScope {
	/** First path segment under /v2, e.g. "api_keys". */
	readonly family: string
	readonly access: "read" | "write"
}

/**
 * Mechanical scope derivation: the resource family is the first path segment
 * after `/v2/`, and the access level follows the HTTP method (GET/HEAD → read,
 * everything else → write). Returns null for non-/v2 paths.
 */
export const requiredScopeForRequest = (method: string, path: string): RequiredScope | null => {
	const match = /^\/v2\/([a-z][a-z0-9_]*)(?:\/|$)/.exec(path)
	if (match === null) return null
	const access = method === "GET" || method === "HEAD" ? "read" : "write"
	return { family: match[1]!, access }
}

/**
 * Scope check for API-key tenants. `write` implies `read` (Stripe semantics).
 * A key with no scopes recorded (legacy key) has full access; session-token
 * tenants are never scope-checked (they carry no scopes).
 */
export const scopeAllows = (
	scopes: ReadonlyArray<string> | null | undefined,
	required: RequiredScope,
): boolean => {
	if (scopes == null) return true
	if (scopes.includes("*")) return true
	if (scopes.includes(`${required.family}:write`)) return true
	return required.access === "read" && scopes.includes(`${required.family}:read`)
}
