import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"
import { HazelChannelId, HazelOrganizationId } from "../primitives"

export class HazelIntegrationStatus extends Schema.Class<HazelIntegrationStatus>("HazelIntegrationStatus")({
	connected: Schema.Boolean,
	externalUserId: Schema.NullOr(Schema.String),
	externalUserEmail: Schema.NullOr(Schema.String),
	connectedByUserId: Schema.NullOr(Schema.String),
	scope: Schema.NullOr(Schema.String),
}) {}

export class HazelOrganizationSummary extends Schema.Class<HazelOrganizationSummary>(
	"HazelOrganizationSummary",
)({
	id: HazelOrganizationId,
	name: Schema.String,
	slug: Schema.NullOr(Schema.String),
	logoUrl: Schema.NullOr(Schema.String),
}) {}

export class HazelOrganizationsListResponse extends Schema.Class<HazelOrganizationsListResponse>(
	"HazelOrganizationsListResponse",
)({
	organizations: Schema.Array(HazelOrganizationSummary),
}) {}

export const HazelChannelType = Schema.Literals(["public", "private"]).annotate({
	identifier: "@maple/HazelChannelType",
	title: "Hazel Channel Type",
})
export type HazelChannelType = Schema.Schema.Type<typeof HazelChannelType>

export class HazelChannelSummary extends Schema.Class<HazelChannelSummary>("HazelChannelSummary")({
	id: HazelChannelId,
	name: Schema.String,
	type: HazelChannelType,
	organizationId: HazelOrganizationId,
}) {}

export class HazelChannelsListResponse extends Schema.Class<HazelChannelsListResponse>(
	"HazelChannelsListResponse",
)({
	channels: Schema.Array(HazelChannelSummary),
}) {}

export class HazelStartConnectRequest extends Schema.Class<HazelStartConnectRequest>(
	"HazelStartConnectRequest",
)({
	returnTo: Schema.optionalKey(Schema.String),
}) {}

export class HazelStartConnectResponse extends Schema.Class<HazelStartConnectResponse>(
	"HazelStartConnectResponse",
)({
	redirectUrl: Schema.String,
	state: Schema.String,
}) {}

export class HazelDisconnectResponse extends Schema.Class<HazelDisconnectResponse>("HazelDisconnectResponse")(
	{
		disconnected: Schema.Boolean,
	},
) {}

export class IntegrationsForbiddenError extends Schema.TaggedErrorClass<IntegrationsForbiddenError>()(
	"@maple/http/errors/IntegrationsForbiddenError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 403 },
) {}

export class IntegrationsValidationError extends Schema.TaggedErrorClass<IntegrationsValidationError>()(
	"@maple/http/errors/IntegrationsValidationError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class IntegrationsNotConnectedError extends Schema.TaggedErrorClass<IntegrationsNotConnectedError>()(
	"@maple/http/errors/IntegrationsNotConnectedError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 409 },
) {}

export class IntegrationsRevokedError extends Schema.TaggedErrorClass<IntegrationsRevokedError>()(
	"@maple/http/errors/IntegrationsRevokedError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 401 },
) {}

export class IntegrationsUpstreamError extends Schema.TaggedErrorClass<IntegrationsUpstreamError>()(
	"@maple/http/errors/IntegrationsUpstreamError",
	{
		message: Schema.String,
		status: Schema.optionalKey(Schema.Number),
	},
	{ httpApiStatus: 502 },
) {}

export class IntegrationsPersistenceError extends Schema.TaggedErrorClass<IntegrationsPersistenceError>()(
	"@maple/http/errors/IntegrationsPersistenceError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 503 },
) {}

export class IntegrationsApiGroup extends HttpApiGroup.make("integrations")
	.add(
		HttpApiEndpoint.get("hazelStatus", "/hazel/status", {
			success: HazelIntegrationStatus,
			error: IntegrationsPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("hazelStart", "/hazel/start", {
			payload: HazelStartConnectRequest,
			success: HazelStartConnectResponse,
			error: [
				IntegrationsForbiddenError,
				IntegrationsValidationError,
				IntegrationsUpstreamError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("hazelOrganizations", "/hazel/organizations", {
			success: HazelOrganizationsListResponse,
			error: [
				IntegrationsValidationError,
				IntegrationsNotConnectedError,
				IntegrationsRevokedError,
				IntegrationsUpstreamError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("hazelChannels", "/hazel/organizations/:organizationId/channels", {
			params: {
				organizationId: HazelOrganizationId,
			},
			success: HazelChannelsListResponse,
			error: [
				IntegrationsValidationError,
				IntegrationsNotConnectedError,
				IntegrationsRevokedError,
				IntegrationsUpstreamError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("hazelDisconnect", "/hazel", {
			success: HazelDisconnectResponse,
			error: [IntegrationsForbiddenError, IntegrationsPersistenceError],
		}),
	)
	.prefix("/api/integrations")
	.middleware(Authorization) {}
