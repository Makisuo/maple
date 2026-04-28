import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { OrgId, UserId } from "../primitives"
import { Authorization, TenantSchema } from "./current-tenant"

export class SelfHostedLoginRequest extends Schema.Class<SelfHostedLoginRequest>("SelfHostedLoginRequest")({
	password: Schema.String,
}) {}

export class SelfHostedLoginResponse extends Schema.Class<SelfHostedLoginResponse>("SelfHostedLoginResponse")(
	{
		token: Schema.String,
		orgId: OrgId,
		userId: UserId,
	},
) {}

export class SelfHostedAuthDisabledError extends Schema.TaggedErrorClass<SelfHostedAuthDisabledError>()(
	"@maple/http/errors/SelfHostedAuthDisabledError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class SelfHostedInvalidPasswordError extends Schema.TaggedErrorClass<SelfHostedInvalidPasswordError>()(
	"@maple/http/errors/SelfHostedInvalidPasswordError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 401 },
) {}

export class AuthPublicApiGroup extends HttpApiGroup.make("authPublic")
	.add(
		HttpApiEndpoint.post("login", "/login", {
			payload: SelfHostedLoginRequest,
			success: SelfHostedLoginResponse,
			error: [SelfHostedAuthDisabledError, SelfHostedInvalidPasswordError],
		}),
	)
	.prefix("/api/auth") {}

export class AuthApiGroup extends HttpApiGroup.make("auth")
	.add(
		HttpApiEndpoint.get("session", "/session", {
			success: TenantSchema,
		}),
	)
	.prefix("/api/auth")
	.middleware(Authorization) {}
