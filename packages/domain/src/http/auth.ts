import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { OrgId, UserId } from "../primitives"
import { Authorization, TenantSchema } from "./current-tenant"

export class CliDeviceStartRequest extends Schema.Class<CliDeviceStartRequest>("CliDeviceStartRequest")({
	deviceName: Schema.String,
}) {}

export class CliDeviceStartResponse extends Schema.Class<CliDeviceStartResponse>("CliDeviceStartResponse")({
	deviceCode: Schema.String,
	userCode: Schema.String,
	verificationUri: Schema.String,
	verificationUriComplete: Schema.String,
	expiresIn: Schema.Number,
	interval: Schema.Number,
}) {}

export class CliDevicePollRequest extends Schema.Class<CliDevicePollRequest>("CliDevicePollRequest")({
	deviceCode: Schema.String,
}) {}

export class CliDevicePendingResponse extends Schema.Class<CliDevicePendingResponse>(
	"CliDevicePendingResponse",
)({
	status: Schema.Literal("pending"),
	interval: Schema.Number,
}) {}

export class CliDeviceCompleteResponse extends Schema.Class<CliDeviceCompleteResponse>(
	"CliDeviceCompleteResponse",
)({
	status: Schema.Literal("complete"),
	token: Schema.String,
	orgId: OrgId,
	userId: UserId,
}) {}

export class CliDeviceDeniedResponse extends Schema.Class<CliDeviceDeniedResponse>("CliDeviceDeniedResponse")(
	{
		status: Schema.Literal("denied"),
	},
) {}

export class CliDeviceExpiredResponse extends Schema.Class<CliDeviceExpiredResponse>(
	"CliDeviceExpiredResponse",
)({
	status: Schema.Literal("expired"),
}) {}

export const CliDevicePollResponse = Schema.Union([
	CliDevicePendingResponse,
	CliDeviceCompleteResponse,
	CliDeviceDeniedResponse,
	CliDeviceExpiredResponse,
])

export class CliDeviceInfoResponse extends Schema.Class<CliDeviceInfoResponse>("CliDeviceInfoResponse")({
	userCode: Schema.String,
	deviceName: Schema.String,
	expiresAt: Schema.String,
	status: Schema.Literals(["pending", "approved", "denied", "complete"]),
}) {}

export class CliDeviceActionResponse extends Schema.Class<CliDeviceActionResponse>("CliDeviceActionResponse")(
	{
		status: Schema.Literals(["approved", "denied", "revoked"]),
	},
) {}

export class CliDeviceNotFoundError extends Schema.TaggedErrorClass<CliDeviceNotFoundError>()(
	"@maple/http/errors/CliDeviceNotFoundError",
	{ message: Schema.String },
	{ httpApiStatus: 404 },
) {}

export class CliDeviceExpiredError extends Schema.TaggedErrorClass<CliDeviceExpiredError>()(
	"@maple/http/errors/CliDeviceExpiredError",
	{ message: Schema.String },
	{ httpApiStatus: 410 },
) {}

export class CliDeviceConflictError extends Schema.TaggedErrorClass<CliDeviceConflictError>()(
	"@maple/http/errors/CliDeviceConflictError",
	{ message: Schema.String },
	{ httpApiStatus: 409 },
) {}

export class CliDevicePersistenceError extends Schema.TaggedErrorClass<CliDevicePersistenceError>()(
	"@maple/http/errors/CliDevicePersistenceError",
	{ message: Schema.String },
	{ httpApiStatus: 503 },
) {}

export class CliDeviceRateLimitError extends Schema.TaggedErrorClass<CliDeviceRateLimitError>()(
	"@maple/http/errors/CliDeviceRateLimitError",
	{ message: Schema.String },
	{ httpApiStatus: 429 },
) {}

export class McpOAuthAuthorizationInfoResponse extends Schema.Class<McpOAuthAuthorizationInfoResponse>(
	"McpOAuthAuthorizationInfoResponse",
)({
	clientName: Schema.String,
	redirectUri: Schema.String,
	resource: Schema.String,
	scopes: Schema.Array(Schema.String),
	expiresAt: Schema.String,
	status: Schema.Literals(["pending", "approved", "denied", "used"]),
}) {}

export class McpOAuthAuthorizationActionResponse extends Schema.Class<McpOAuthAuthorizationActionResponse>(
	"McpOAuthAuthorizationActionResponse",
)({
	status: Schema.Literals(["approved", "denied"]),
	redirectUri: Schema.String,
}) {}

export class McpOAuthAuthorizationNotFoundError extends Schema.TaggedErrorClass<McpOAuthAuthorizationNotFoundError>()(
	"@maple/http/errors/McpOAuthAuthorizationNotFoundError",
	{ message: Schema.String },
	{ httpApiStatus: 404 },
) {}

export class McpOAuthAuthorizationExpiredError extends Schema.TaggedErrorClass<McpOAuthAuthorizationExpiredError>()(
	"@maple/http/errors/McpOAuthAuthorizationExpiredError",
	{ message: Schema.String },
	{ httpApiStatus: 410 },
) {}

export class McpOAuthAuthorizationConflictError extends Schema.TaggedErrorClass<McpOAuthAuthorizationConflictError>()(
	"@maple/http/errors/McpOAuthAuthorizationConflictError",
	{ message: Schema.String },
	{ httpApiStatus: 409 },
) {}

export class McpOAuthPersistenceError extends Schema.TaggedErrorClass<McpOAuthPersistenceError>()(
	"@maple/http/errors/McpOAuthPersistenceError",
	{ message: Schema.String },
	{ httpApiStatus: 503 },
) {}

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
	.add(
		HttpApiEndpoint.post("cliDeviceStart", "/cli/device", {
			payload: CliDeviceStartRequest,
			success: CliDeviceStartResponse,
			error: [CliDevicePersistenceError, CliDeviceRateLimitError],
		}),
	)
	.add(
		HttpApiEndpoint.post("cliDevicePoll", "/cli/device/token", {
			payload: CliDevicePollRequest,
			success: CliDevicePollResponse,
			error: [CliDevicePersistenceError, CliDeviceRateLimitError],
		}),
	)
	.prefix("/api/auth") {}

export class AuthApiGroup extends HttpApiGroup.make("auth")
	.add(
		HttpApiEndpoint.get("session", "/session", {
			success: TenantSchema,
		}),
	)
	.add(
		HttpApiEndpoint.get("cliDeviceInspect", "/cli/device/:userCode", {
			params: { userCode: Schema.String },
			success: CliDeviceInfoResponse,
			error: [CliDeviceNotFoundError, CliDeviceExpiredError, CliDevicePersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.post("cliDeviceApprove", "/cli/device/:userCode/approve", {
			params: { userCode: Schema.String },
			success: CliDeviceActionResponse,
			error: [
				CliDeviceNotFoundError,
				CliDeviceExpiredError,
				CliDeviceConflictError,
				CliDevicePersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.post("cliDeviceDeny", "/cli/device/:userCode/deny", {
			params: { userCode: Schema.String },
			success: CliDeviceActionResponse,
			error: [
				CliDeviceNotFoundError,
				CliDeviceExpiredError,
				CliDeviceConflictError,
				CliDevicePersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("cliSessionRevoke", "/cli/session", {
			success: CliDeviceActionResponse,
			error: [CliDeviceConflictError, CliDevicePersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.get("mcpOAuthAuthorizationInspect", "/mcp/oauth/authorization/:requestId", {
			params: { requestId: Schema.String },
			success: McpOAuthAuthorizationInfoResponse,
			error: [
				McpOAuthAuthorizationNotFoundError,
				McpOAuthAuthorizationExpiredError,
				McpOAuthPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.post("mcpOAuthAuthorizationApprove", "/mcp/oauth/authorization/:requestId/approve", {
			params: { requestId: Schema.String },
			success: McpOAuthAuthorizationActionResponse,
			error: [
				McpOAuthAuthorizationNotFoundError,
				McpOAuthAuthorizationExpiredError,
				McpOAuthAuthorizationConflictError,
				McpOAuthPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.post("mcpOAuthAuthorizationDeny", "/mcp/oauth/authorization/:requestId/deny", {
			params: { requestId: Schema.String },
			success: McpOAuthAuthorizationActionResponse,
			error: [
				McpOAuthAuthorizationNotFoundError,
				McpOAuthAuthorizationExpiredError,
				McpOAuthAuthorizationConflictError,
				McpOAuthPersistenceError,
			],
		}),
	)
	.prefix("/api/auth")
	.middleware(Authorization) {}
