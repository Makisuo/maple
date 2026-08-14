import { HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi"
import { Schema, Context as EffectContext } from "effect"
import { AuthMode, OrgId, RoleName, UserId } from "../primitives"
import { HttpTaggedError } from "./error-policy"

export class UnauthorizedError extends HttpTaggedError<UnauthorizedError>()(
	"@maple/http/errors/UnauthorizedError",
	{
		message: Schema.String,
	},
	{
		status: 401,
		code: "invalid_credentials",
		title: "Sign in required",
		message: "Invalid or missing credentials.",
		retry: "never",
		recovery: "reauthenticate",
		exposure: "redacted",
	},
) {}

/** Credential storage could not be consulted; this is not an invalid token. */
export class AuthorizationUnavailableError extends HttpTaggedError<AuthorizationUnavailableError>()(
	"@maple/http/errors/AuthorizationUnavailableError",
	{ message: Schema.String },
	{
		status: 503,
		code: "authorization_unavailable",
		title: "Authentication is temporarily unavailable",
		message: "Authentication is temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class TenantSchema extends Schema.Class<TenantSchema>("TenantSchema")({
	orgId: OrgId,
	userId: UserId,
	roles: Schema.Array(RoleName),
	authMode: AuthMode,
	// Present only for API-key auth with restricted scopes (v2). Undefined for
	// session tokens and legacy full-access keys — those bypass scope checks.
	scopes: Schema.optional(Schema.Array(Schema.String)),
}) {}

export class Context extends EffectContext.Service<Context, TenantSchema>()(
	"@maple/domain/http/CurrentTenant",
) {}

export class Authorization extends HttpApiMiddleware.Service<
	Authorization,
	{
		provides: Context
	}
>()("Authorization", {
	error: [UnauthorizedError, AuthorizationUnavailableError],
	security: {
		bearer: HttpApiSecurity.bearer,
	},
}) {}

/**
 * An API key was presented to a session-only (internal) endpoint.
 *
 * Distinct from `UnauthorizedError` on purpose: the credential is valid, it is
 * simply not accepted here. A bare 401 would read as "your key is broken" and
 * send people to rotate it; this says where the supported surface is instead.
 */
export class ApiKeyNotAcceptedError extends HttpTaggedError<ApiKeyNotAcceptedError>()(
	"@maple/http/errors/ApiKeyNotAcceptedError",
	{
		message: Schema.String,
	},
	{
		status: 403,
		code: "api_key_not_accepted",
		title: "Not available to API keys",
		message:
			"This endpoint backs the Maple dashboard and is not part of the public API. Use the /v2 API instead.",
		retry: "never",
		recovery: "none",
		exposure: "public_message",
	},
) {}

/**
 * Session-only sibling of {@link Authorization}, for endpoints that are
 * dashboard transport rather than public API.
 *
 * Provides the same `Context`, so handlers written against `Authorization` need
 * no changes — only the group's `.middleware(...)` line differs.
 */
export class SessionAuthorization extends HttpApiMiddleware.Service<
	SessionAuthorization,
	{
		provides: Context
	}
>()("SessionAuthorization", {
	error: [UnauthorizedError, AuthorizationUnavailableError, ApiKeyNotAcceptedError],
	security: {
		bearer: HttpApiSecurity.bearer,
	},
}) {}
