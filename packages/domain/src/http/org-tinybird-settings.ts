import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"
import { IsoDateTimeString } from "../primitives"

export const OrgTinybirdSyncStatus = Schema.Literals(["active", "error", "out_of_sync", "syncing"])
export type OrgTinybirdSyncStatus = Schema.Schema.Type<typeof OrgTinybirdSyncStatus>

/**
 * Which backend an org's per-org BYO config targets.
 * - `"tinybird"`: a Tinybird workspace; Maple deploys its project to it via TinybirdSyncClient.
 * - `"clickhouse"`: a vanilla ClickHouse instance; the operator applies the schema themselves
 *   via the `clickhouse:schema:apply` CLI before pointing Maple at it.
 */
export const OrgTinybirdBackend = Schema.Literals(["tinybird", "clickhouse"])
export type OrgTinybirdBackend = Schema.Schema.Type<typeof OrgTinybirdBackend>

export const OrgTinybirdSyncRunStatus = Schema.Literals(["queued", "running", "failed", "succeeded"])
export type OrgTinybirdSyncRunStatus = Schema.Schema.Type<typeof OrgTinybirdSyncRunStatus>

export const OrgTinybirdSyncPhase = Schema.Literals([
	"starting",
	"deploying",
	"waiting_for_data",
	"setting_live",
	"failed",
	"succeeded",
])
export type OrgTinybirdSyncPhase = Schema.Schema.Type<typeof OrgTinybirdSyncPhase>

export class OrgTinybirdCurrentRunResponse extends Schema.Class<OrgTinybirdCurrentRunResponse>(
	"OrgTinybirdCurrentRunResponse",
)({
	targetHost: Schema.String,
	targetProjectRevision: Schema.String,
	runStatus: OrgTinybirdSyncRunStatus,
	phase: OrgTinybirdSyncPhase,
	deploymentId: Schema.NullOr(Schema.String),
	deploymentStatus: Schema.NullOr(Schema.String),
	errorMessage: Schema.NullOr(Schema.String),
	startedAt: IsoDateTimeString,
	updatedAt: IsoDateTimeString,
	finishedAt: Schema.NullOr(IsoDateTimeString),
	isTerminal: Schema.Boolean,
}) {}

export class OrgTinybirdSettingsResponse extends Schema.Class<OrgTinybirdSettingsResponse>(
	"OrgTinybirdSettingsResponse",
)({
	configured: Schema.Boolean,
	backend: Schema.NullOr(OrgTinybirdBackend),
	activeHost: Schema.NullOr(Schema.String),
	draftHost: Schema.NullOr(Schema.String),
	// ClickHouse-specific projection (no password ever returned to the client).
	chUrl: Schema.NullOr(Schema.String),
	chUser: Schema.NullOr(Schema.String),
	chDatabase: Schema.NullOr(Schema.String),
	syncStatus: Schema.NullOr(OrgTinybirdSyncStatus),
	lastSyncAt: Schema.NullOr(IsoDateTimeString),
	lastSyncError: Schema.NullOr(Schema.String),
	projectRevision: Schema.NullOr(Schema.String),
	logsRetentionDays: Schema.NullOr(Schema.Number),
	tracesRetentionDays: Schema.NullOr(Schema.Number),
	metricsRetentionDays: Schema.NullOr(Schema.Number),
	currentRun: Schema.NullOr(OrgTinybirdCurrentRunResponse),
}) {}

/**
 * Upsert payload for per-org BYO settings.
 *
 * The `backend` field selects the shape: `"tinybird"` (default for backwards
 * compatibility) requires `host` + `token`; `"clickhouse"` requires `url` +
 * `user` + `database`, with optional `password`. Retention fields are only
 * meaningful for Tinybird (TTL on a Maple-managed Tinybird project). For CH
 * the operator is responsible for retention via TTL clauses in the schema.
 */
export class OrgTinybirdSettingsUpsertRequest extends Schema.Class<OrgTinybirdSettingsUpsertRequest>(
	"OrgTinybirdSettingsUpsertRequest",
)({
	backend: Schema.optionalKey(OrgTinybirdBackend),
	// Tinybird-only fields
	host: Schema.optionalKey(Schema.String),
	token: Schema.optionalKey(Schema.String),
	logsRetentionDays: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	tracesRetentionDays: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	metricsRetentionDays: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	// ClickHouse-only fields
	url: Schema.optionalKey(Schema.String),
	user: Schema.optionalKey(Schema.String),
	password: Schema.optionalKey(Schema.String),
	database: Schema.optionalKey(Schema.String),
}) {}

export class OrgTinybirdDeploymentStatusResponse extends Schema.Class<OrgTinybirdDeploymentStatusResponse>(
	"OrgTinybirdDeploymentStatusResponse",
)({
	hasRun: Schema.Boolean,
	hasDeployment: Schema.Boolean,
	deploymentId: Schema.NullOr(Schema.String),
	status: Schema.NullOr(Schema.String),
	deploymentStatus: Schema.NullOr(Schema.String),
	runStatus: Schema.NullOr(OrgTinybirdSyncRunStatus),
	phase: Schema.NullOr(OrgTinybirdSyncPhase),
	isTerminal: Schema.NullOr(Schema.Boolean),
	errorMessage: Schema.NullOr(Schema.String),
	startedAt: Schema.NullOr(IsoDateTimeString),
	updatedAt: Schema.NullOr(IsoDateTimeString),
	finishedAt: Schema.NullOr(IsoDateTimeString),
}) {}

const OrgTinybirdDatasourceStats = Schema.Struct({
	name: Schema.String,
	rowCount: Schema.Number,
	bytes: Schema.Number,
})

export class OrgTinybirdInstanceHealthResponse extends Schema.Class<OrgTinybirdInstanceHealthResponse>(
	"OrgTinybirdInstanceHealthResponse",
)({
	workspaceName: Schema.NullOr(Schema.String),
	datasources: Schema.Array(OrgTinybirdDatasourceStats),
	totalRows: Schema.Number,
	totalBytes: Schema.Number,
	recentErrorCount: Schema.Number,
	avgQueryLatencyMs: Schema.NullOr(Schema.Number),
}) {}

export class OrgTinybirdSettingsDeleteResponse extends Schema.Class<OrgTinybirdSettingsDeleteResponse>(
	"OrgTinybirdSettingsDeleteResponse",
)({
	configured: Schema.Literal(false),
}) {}

export class OrgTinybirdSettingsForbiddenError extends Schema.TaggedErrorClass<OrgTinybirdSettingsForbiddenError>()(
	"@maple/http/errors/OrgTinybirdSettingsForbiddenError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 403 },
) {}

export class OrgTinybirdSettingsValidationError extends Schema.TaggedErrorClass<OrgTinybirdSettingsValidationError>()(
	"@maple/http/errors/OrgTinybirdSettingsValidationError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class OrgTinybirdSettingsPersistenceError extends Schema.TaggedErrorClass<OrgTinybirdSettingsPersistenceError>()(
	"@maple/http/errors/OrgTinybirdSettingsPersistenceError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 503 },
) {}

export class OrgTinybirdSettingsEncryptionError extends Schema.TaggedErrorClass<OrgTinybirdSettingsEncryptionError>()(
	"@maple/http/errors/OrgTinybirdSettingsEncryptionError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 500 },
) {}

export class OrgTinybirdSettingsSyncConflictError extends Schema.TaggedErrorClass<OrgTinybirdSettingsSyncConflictError>()(
	"@maple/http/errors/OrgTinybirdSettingsSyncConflictError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 409 },
) {}

export class OrgTinybirdSettingsUpstreamRejectedError extends Schema.TaggedErrorClass<OrgTinybirdSettingsUpstreamRejectedError>()(
	"@maple/http/errors/OrgTinybirdSettingsUpstreamRejectedError",
	{
		message: Schema.String,
		statusCode: Schema.NullOr(Schema.Number),
	},
	{ httpApiStatus: 400 },
) {}

export class OrgTinybirdSettingsUpstreamUnavailableError extends Schema.TaggedErrorClass<OrgTinybirdSettingsUpstreamUnavailableError>()(
	"@maple/http/errors/OrgTinybirdSettingsUpstreamUnavailableError",
	{
		message: Schema.String,
		statusCode: Schema.NullOr(Schema.Number),
	},
	{ httpApiStatus: 503 },
) {}

export class OrgTinybirdSettingsApiGroup extends HttpApiGroup.make("orgTinybirdSettings")
	.add(
		HttpApiEndpoint.get("get", "/", {
			success: OrgTinybirdSettingsResponse,
			error: [OrgTinybirdSettingsForbiddenError, OrgTinybirdSettingsPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.put("upsert", "/", {
			payload: OrgTinybirdSettingsUpsertRequest,
			success: OrgTinybirdSettingsResponse,
			error: [
				OrgTinybirdSettingsForbiddenError,
				OrgTinybirdSettingsValidationError,
				OrgTinybirdSettingsPersistenceError,
				OrgTinybirdSettingsEncryptionError,
				OrgTinybirdSettingsSyncConflictError,
				OrgTinybirdSettingsUpstreamRejectedError,
				OrgTinybirdSettingsUpstreamUnavailableError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.post("resync", "/resync", {
			success: OrgTinybirdSettingsResponse,
			error: [
				OrgTinybirdSettingsForbiddenError,
				OrgTinybirdSettingsValidationError,
				OrgTinybirdSettingsPersistenceError,
				OrgTinybirdSettingsEncryptionError,
				OrgTinybirdSettingsSyncConflictError,
				OrgTinybirdSettingsUpstreamRejectedError,
				OrgTinybirdSettingsUpstreamUnavailableError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("deploymentStatus", "/deployment-status", {
			success: OrgTinybirdDeploymentStatusResponse,
			error: [
				OrgTinybirdSettingsForbiddenError,
				OrgTinybirdSettingsValidationError,
				OrgTinybirdSettingsPersistenceError,
				OrgTinybirdSettingsEncryptionError,
				OrgTinybirdSettingsUpstreamUnavailableError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("instanceHealth", "/instance-health", {
			success: OrgTinybirdInstanceHealthResponse,
			error: [
				OrgTinybirdSettingsForbiddenError,
				OrgTinybirdSettingsValidationError,
				OrgTinybirdSettingsPersistenceError,
				OrgTinybirdSettingsEncryptionError,
				OrgTinybirdSettingsUpstreamRejectedError,
				OrgTinybirdSettingsUpstreamUnavailableError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/", {
			success: OrgTinybirdSettingsDeleteResponse,
			error: [OrgTinybirdSettingsForbiddenError, OrgTinybirdSettingsPersistenceError],
		}),
	)
	.prefix("/api/org-tinybird-settings")
	.middleware(Authorization) {}
