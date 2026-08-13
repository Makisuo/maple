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
