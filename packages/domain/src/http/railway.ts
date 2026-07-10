import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import {
	IsoDateTimeString,
	RailwayConnectionId,
	RailwayMetricsIntervalSeconds,
	RailwayTargetId,
	RailwayTokenType,
} from "../primitives"
import { Authorization } from "./current-tenant"

/**
 * Railway integration: an org pastes a Railway workspace/account API token;
 * Maple discovers projects → environments → services and pulls runtime logs
 * (GraphQL subscription) + resource metrics (metrics query) via the
 * standalone railway-connector, pushing them through the org's own ingest
 * endpoint as OTLP.
 */

export class RailwayIntegrationStatus extends Schema.Class<RailwayIntegrationStatus>(
	"RailwayIntegrationStatus",
)({
	connected: Schema.Boolean,
	connectionId: Schema.NullOr(RailwayConnectionId),
	tokenType: Schema.NullOr(RailwayTokenType),
	accountName: Schema.NullOr(Schema.String),
	enabled: Schema.Boolean,
	lastValidatedAt: Schema.NullOr(IsoDateTimeString),
	/** Set when Railway rejected the token (401) — the card prompts a reconnect. */
	lastValidationError: Schema.NullOr(Schema.String),
	targetCount: Schema.Number,
	erroredTargetCount: Schema.Number,
}) {}

export class RailwayConnectRequest extends Schema.Class<RailwayConnectRequest>("RailwayConnectRequest")({
	token: Schema.String,
}) {}

export class RailwayDisconnectResponse extends Schema.Class<RailwayDisconnectResponse>(
	"RailwayDisconnectResponse",
)({
	disconnected: Schema.Boolean,
}) {}

export class RailwayDiscoveredService extends Schema.Class<RailwayDiscoveredService>(
	"RailwayDiscoveredService",
)({
	id: Schema.String,
	name: Schema.String,
}) {}

export class RailwayDiscoveredEnvironment extends Schema.Class<RailwayDiscoveredEnvironment>(
	"RailwayDiscoveredEnvironment",
)({
	id: Schema.String,
	name: Schema.String,
	services: Schema.Array(RailwayDiscoveredService),
	/** Id of the existing railway_targets row covering this environment, if any. */
	targetId: Schema.NullOr(RailwayTargetId),
}) {}

export class RailwayDiscoveredProject extends Schema.Class<RailwayDiscoveredProject>(
	"RailwayDiscoveredProject",
)({
	id: Schema.String,
	name: Schema.String,
	environments: Schema.Array(RailwayDiscoveredEnvironment),
}) {}

export class RailwayDiscoveryResponse extends Schema.Class<RailwayDiscoveryResponse>(
	"RailwayDiscoveryResponse",
)({
	projects: Schema.Array(RailwayDiscoveredProject),
}) {}

export class RailwayTargetResponse extends Schema.Class<RailwayTargetResponse>("RailwayTargetResponse")({
	id: RailwayTargetId,
	projectId: Schema.String,
	projectName: Schema.NullOr(Schema.String),
	environmentId: Schema.String,
	environmentName: Schema.NullOr(Schema.String),
	enabled: Schema.Boolean,
	logsEnabled: Schema.Boolean,
	metricsEnabled: Schema.Boolean,
	metricsIntervalSeconds: RailwayMetricsIntervalSeconds,
	serviceCount: Schema.Number,
	lastLogAt: Schema.NullOr(IsoDateTimeString),
	lastMetricsAt: Schema.NullOr(IsoDateTimeString),
	lastSuccessAt: Schema.NullOr(IsoDateTimeString),
	lastError: Schema.NullOr(Schema.String),
	lastErrorAt: Schema.NullOr(IsoDateTimeString),
	createdAt: IsoDateTimeString,
	updatedAt: IsoDateTimeString,
}) {}

export class RailwayTargetsListResponse extends Schema.Class<RailwayTargetsListResponse>(
	"RailwayTargetsListResponse",
)({
	targets: Schema.Array(RailwayTargetResponse),
}) {}

export class CreateRailwayTargetRequest extends Schema.Class<CreateRailwayTargetRequest>(
	"CreateRailwayTargetRequest",
)({
	projectId: Schema.String,
	environmentId: Schema.String,
	logsEnabled: Schema.optionalKey(Schema.Boolean),
	metricsEnabled: Schema.optionalKey(Schema.Boolean),
	metricsIntervalSeconds: Schema.optionalKey(RailwayMetricsIntervalSeconds),
}) {}

export class UpdateRailwayTargetRequest extends Schema.Class<UpdateRailwayTargetRequest>(
	"UpdateRailwayTargetRequest",
)({
	enabled: Schema.optionalKey(Schema.Boolean),
	logsEnabled: Schema.optionalKey(Schema.Boolean),
	metricsEnabled: Schema.optionalKey(Schema.Boolean),
	metricsIntervalSeconds: Schema.optionalKey(RailwayMetricsIntervalSeconds),
}) {}

export class RailwayTargetDeleteResponse extends Schema.Class<RailwayTargetDeleteResponse>(
	"RailwayTargetDeleteResponse",
)({
	id: RailwayTargetId,
}) {}

export class RailwayPersistenceError extends Schema.TaggedErrorClass<RailwayPersistenceError>()(
	"@maple/http/errors/RailwayPersistenceError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 503 },
) {}

export class RailwayValidationError extends Schema.TaggedErrorClass<RailwayValidationError>()(
	"@maple/http/errors/RailwayValidationError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class RailwayEncryptionError extends Schema.TaggedErrorClass<RailwayEncryptionError>()(
	"@maple/http/errors/RailwayEncryptionError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 500 },
) {}

/** Railway's GraphQL API failed or rejected the stored token. */
export class RailwayUpstreamError extends Schema.TaggedErrorClass<RailwayUpstreamError>()(
	"@maple/http/errors/RailwayUpstreamError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 502 },
) {}

export class RailwayNotFoundError extends Schema.TaggedErrorClass<RailwayNotFoundError>()(
	"@maple/http/errors/RailwayNotFoundError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

export class RailwayForbiddenError extends Schema.TaggedErrorClass<RailwayForbiddenError>()(
	"@maple/http/errors/RailwayForbiddenError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 403 },
) {}

export class RailwayApiGroup extends HttpApiGroup.make("railway")
	.add(
		HttpApiEndpoint.get("status", "/status", {
			success: RailwayIntegrationStatus,
			error: RailwayPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("connect", "/connect", {
			payload: RailwayConnectRequest,
			success: RailwayIntegrationStatus,
			error: [
				RailwayValidationError,
				RailwayUpstreamError,
				RailwayPersistenceError,
				RailwayEncryptionError,
				RailwayForbiddenError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.post("disconnect", "/disconnect", {
			success: RailwayDisconnectResponse,
			error: [RailwayPersistenceError, RailwayForbiddenError],
		}),
	)
	.add(
		HttpApiEndpoint.get("discovery", "/discovery", {
			success: RailwayDiscoveryResponse,
			error: [
				RailwayNotFoundError,
				RailwayUpstreamError,
				RailwayPersistenceError,
				RailwayEncryptionError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("listTargets", "/targets", {
			success: RailwayTargetsListResponse,
			error: RailwayPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("createTarget", "/targets", {
			payload: CreateRailwayTargetRequest,
			success: RailwayTargetResponse,
			error: [
				RailwayNotFoundError,
				RailwayValidationError,
				RailwayUpstreamError,
				RailwayPersistenceError,
				RailwayEncryptionError,
				RailwayForbiddenError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.patch("updateTarget", "/targets/:targetId", {
			params: {
				targetId: RailwayTargetId,
			},
			payload: UpdateRailwayTargetRequest,
			success: RailwayTargetResponse,
			error: [
				RailwayNotFoundError,
				RailwayValidationError,
				RailwayPersistenceError,
				RailwayForbiddenError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("deleteTarget", "/targets/:targetId", {
			params: {
				targetId: RailwayTargetId,
			},
			success: RailwayTargetDeleteResponse,
			error: [RailwayNotFoundError, RailwayPersistenceError, RailwayForbiddenError],
		}),
	)
	.prefix("/api/railway")
	.middleware(Authorization) {}
