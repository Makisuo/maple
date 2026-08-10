import { HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi"
import { Schema, Context as EffectContext } from "effect"
import { AuthMode, OrgId, RoleName, UserId } from "../primitives"

export class UnauthorizedError extends Schema.TaggedError<UnauthorizedError>()(
	"@maple/http/errors/UnauthorizedError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 401 },
) {}

/** Credential storage could not be consulted; this is not an invalid token. */
export class AuthorizationUnavailableError extends Schema.TaggedError<AuthorizationUnavailableError>()(
	"@maple/http/errors/AuthorizationUnavailableError",
	{ message: Schema.String },
	{ httpApiStatus: 503 },
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
