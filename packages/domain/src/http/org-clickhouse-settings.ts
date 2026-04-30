import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"
import { IsoDateTimeString } from "../primitives"

/**
 * Connection-level status for a per-org BYO ClickHouse row.
 *
 * - `"connected"`: credentials accepted; the row is valid.
 * - `"error"`: last operation against the cluster failed (see `lastSyncError`).
 *
 * Schema-level state (drift, missing tables) lives on the diff endpoint, not
 * on this status; this field only reflects whether Maple can talk to the
 * cluster at all.
 */
export const OrgClickHouseSettingsStatus = Schema.Literals(["connected", "error"])
export type OrgClickHouseSettingsStatus = Schema.Schema.Type<typeof OrgClickHouseSettingsStatus>

export class OrgClickHouseSettingsResponse extends Schema.Class<OrgClickHouseSettingsResponse>(
	"OrgClickHouseSettingsResponse",
)({
	configured: Schema.Boolean,
	chUrl: Schema.NullOr(Schema.String),
	chUser: Schema.NullOr(Schema.String),
	chDatabase: Schema.NullOr(Schema.String),
	syncStatus: Schema.NullOr(OrgClickHouseSettingsStatus),
	lastSyncAt: Schema.NullOr(IsoDateTimeString),
	lastSyncError: Schema.NullOr(Schema.String),
	/**
	 * Hash of the schema snapshot last successfully applied to the cluster, or
	 * `null` if the user has saved credentials but never applied a schema.
	 * Compared against the bundled `clickHouseProjectRevision` in the diff
	 * endpoint to drive "your schema is behind" hints.
	 */
	schemaVersion: Schema.NullOr(Schema.String),
}) {}

/**
 * Upsert payload for BYO ClickHouse settings.
 *
 * `password` is optional — some CH deployments don't authenticate, and on
 * re-save users can leave it blank to keep the previously stored secret. All
 * other fields are required.
 */
export class OrgClickHouseSettingsUpsertRequest extends Schema.Class<OrgClickHouseSettingsUpsertRequest>(
	"OrgClickHouseSettingsUpsertRequest",
)({
	url: Schema.String,
	user: Schema.String,
	password: Schema.optionalKey(Schema.String),
	database: Schema.String,
}) {}

export class OrgClickHouseSettingsDeleteResponse extends Schema.Class<OrgClickHouseSettingsDeleteResponse>(
	"OrgClickHouseSettingsDeleteResponse",
)({
	configured: Schema.Literal(false),
}) {}

// --- Schema diff & apply -----------------------------------------------------

export const ClickHouseTableKind = Schema.Literals(["table", "materialized_view"])
export type ClickHouseTableKind = Schema.Schema.Type<typeof ClickHouseTableKind>

export const ClickHouseColumnDriftMissing = Schema.Struct({
	kind: Schema.Literal("missing"),
	column: Schema.String,
	expectedType: Schema.String,
})

export const ClickHouseColumnDriftExtra = Schema.Struct({
	kind: Schema.Literal("extra"),
	column: Schema.String,
	actualType: Schema.String,
})

export const ClickHouseColumnDriftTypeMismatch = Schema.Struct({
	kind: Schema.Literal("type_mismatch"),
	column: Schema.String,
	expectedType: Schema.String,
	actualType: Schema.String,
})

export const ClickHouseColumnDrift = Schema.Union([
	ClickHouseColumnDriftMissing,
	ClickHouseColumnDriftExtra,
	ClickHouseColumnDriftTypeMismatch,
])
export type ClickHouseColumnDrift = Schema.Schema.Type<typeof ClickHouseColumnDrift>

export const ClickHouseTableDiffEntry = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("up_to_date"),
		name: Schema.String,
		kind: ClickHouseTableKind,
	}),
	Schema.Struct({
		status: Schema.Literal("missing"),
		name: Schema.String,
		kind: ClickHouseTableKind,
	}),
	Schema.Struct({
		status: Schema.Literal("drifted"),
		name: Schema.String,
		kind: ClickHouseTableKind,
		columnDrifts: Schema.Array(ClickHouseColumnDrift),
	}),
])
export type ClickHouseTableDiffEntry = Schema.Schema.Type<typeof ClickHouseTableDiffEntry>

export class OrgClickHouseSchemaDiffResponse extends Schema.Class<OrgClickHouseSchemaDiffResponse>(
	"OrgClickHouseSchemaDiffResponse",
)({
	/** Hash of the bundled snapshot — i.e. what Maple expects the cluster to look like. */
	expectedSchemaVersion: Schema.String,
	/** Hash of the snapshot we last successfully applied. `null` before first apply. */
	appliedSchemaVersion: Schema.NullOr(Schema.String),
	entries: Schema.Array(ClickHouseTableDiffEntry),
}) {}

export class OrgClickHouseApplySchemaResult extends Schema.Class<OrgClickHouseApplySchemaResult>(
	"OrgClickHouseApplySchemaResult",
)({
	applied: Schema.Array(Schema.String),
	skipped: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			reason: Schema.String,
		}),
	),
}) {}

/**
 * Pre-rendered OpenTelemetry Collector YAML for an org's ClickHouse backend.
 *
 * Lets a customer skip the "compose your own collector config" step — they
 * download this, set `MAPLE_CLICKHOUSE_PASSWORD`, and run the maple-otel
 * collector image:
 *
 *   docker run \
 *     -e MAPLE_CLICKHOUSE_PASSWORD=$PASS \
 *     -v ./collector.yaml:/etc/otel/config.yaml \
 *     -p 4317:4317 -p 4318:4318 \
 *     ghcr.io/makisuo/maple/otel-collector-maple:latest
 *
 * The password is intentionally NOT inlined — the body references
 * `${env:MAPLE_CLICKHOUSE_PASSWORD}` so the file is safe to share.
 */
export class OrgClickHouseCollectorConfigResponse extends Schema.Class<OrgClickHouseCollectorConfigResponse>(
	"OrgClickHouseCollectorConfigResponse",
)({
	/** The full collector YAML body, ready to drop into `--config=`. */
	yaml: Schema.String,
	/** Image reference customers should run to consume this YAML. */
	image: Schema.String,
	/** Name of the env var the customer must set with the CH password. */
	passwordEnvVar: Schema.String,
}) {}

// --- Errors ------------------------------------------------------------------

export class OrgClickHouseSettingsForbiddenError extends Schema.TaggedErrorClass<OrgClickHouseSettingsForbiddenError>()(
	"@maple/http/errors/OrgClickHouseSettingsForbiddenError",
	{ message: Schema.String },
	{ httpApiStatus: 403 },
) {}

export class OrgClickHouseSettingsValidationError extends Schema.TaggedErrorClass<OrgClickHouseSettingsValidationError>()(
	"@maple/http/errors/OrgClickHouseSettingsValidationError",
	{ message: Schema.String },
	{ httpApiStatus: 400 },
) {}

export class OrgClickHouseSettingsPersistenceError extends Schema.TaggedErrorClass<OrgClickHouseSettingsPersistenceError>()(
	"@maple/http/errors/OrgClickHouseSettingsPersistenceError",
	{ message: Schema.String },
	{ httpApiStatus: 503 },
) {}

export class OrgClickHouseSettingsEncryptionError extends Schema.TaggedErrorClass<OrgClickHouseSettingsEncryptionError>()(
	"@maple/http/errors/OrgClickHouseSettingsEncryptionError",
	{ message: Schema.String },
	{ httpApiStatus: 500 },
) {}

export class OrgClickHouseSettingsUpstreamRejectedError extends Schema.TaggedErrorClass<OrgClickHouseSettingsUpstreamRejectedError>()(
	"@maple/http/errors/OrgClickHouseSettingsUpstreamRejectedError",
	{
		message: Schema.String,
		statusCode: Schema.NullOr(Schema.Number),
	},
	{ httpApiStatus: 400 },
) {}

export class OrgClickHouseSettingsUpstreamUnavailableError extends Schema.TaggedErrorClass<OrgClickHouseSettingsUpstreamUnavailableError>()(
	"@maple/http/errors/OrgClickHouseSettingsUpstreamUnavailableError",
	{
		message: Schema.String,
		statusCode: Schema.NullOr(Schema.Number),
	},
	{ httpApiStatus: 503 },
) {}

// --- API group ---------------------------------------------------------------

export class OrgClickHouseSettingsApiGroup extends HttpApiGroup.make("orgClickHouseSettings")
	.add(
		HttpApiEndpoint.get("get", "/", {
			success: OrgClickHouseSettingsResponse,
			error: [OrgClickHouseSettingsForbiddenError, OrgClickHouseSettingsPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.put("upsert", "/", {
			payload: OrgClickHouseSettingsUpsertRequest,
			success: OrgClickHouseSettingsResponse,
			error: [
				OrgClickHouseSettingsForbiddenError,
				OrgClickHouseSettingsValidationError,
				OrgClickHouseSettingsPersistenceError,
				OrgClickHouseSettingsEncryptionError,
				OrgClickHouseSettingsUpstreamRejectedError,
				OrgClickHouseSettingsUpstreamUnavailableError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("schemaDiff", "/schema-diff", {
			success: OrgClickHouseSchemaDiffResponse,
			error: [
				OrgClickHouseSettingsForbiddenError,
				OrgClickHouseSettingsValidationError,
				OrgClickHouseSettingsPersistenceError,
				OrgClickHouseSettingsEncryptionError,
				OrgClickHouseSettingsUpstreamRejectedError,
				OrgClickHouseSettingsUpstreamUnavailableError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.post("applySchema", "/apply-schema", {
			success: OrgClickHouseApplySchemaResult,
			error: [
				OrgClickHouseSettingsForbiddenError,
				OrgClickHouseSettingsValidationError,
				OrgClickHouseSettingsPersistenceError,
				OrgClickHouseSettingsEncryptionError,
				OrgClickHouseSettingsUpstreamRejectedError,
				OrgClickHouseSettingsUpstreamUnavailableError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("collectorConfig", "/collector-config", {
			success: OrgClickHouseCollectorConfigResponse,
			error: [
				OrgClickHouseSettingsForbiddenError,
				OrgClickHouseSettingsValidationError,
				OrgClickHouseSettingsPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/", {
			success: OrgClickHouseSettingsDeleteResponse,
			error: [OrgClickHouseSettingsForbiddenError, OrgClickHouseSettingsPersistenceError],
		}),
	)
	.prefix("/api/org-clickhouse-settings")
	.middleware(Authorization) {}
