import { Schema } from "effect"
import { HttpTaggedError } from "./error-policy"

/** The caller is not allowed to manage the organization's ClickHouse connection. */
export class OrgClickHouseSettingsForbiddenError extends HttpTaggedError<OrgClickHouseSettingsForbiddenError>()(
	"@maple/http/errors/OrgClickHouseSettingsForbiddenError",
	{ message: Schema.String },
	{
		status: 403,
		code: "clickhouse_settings_forbidden",
		title: "Permission required",
		retry: "never",
		recovery: "request_access",
		exposure: "public_message",
	},
) {}

/** Caller-supplied ClickHouse settings do not pass validation. */
export class OrgClickHouseSettingsValidationError extends HttpTaggedError<OrgClickHouseSettingsValidationError>()(
	"@maple/http/errors/OrgClickHouseSettingsValidationError",
	{ message: Schema.String },
	{
		status: 400,
		code: "clickhouse_settings_invalid",
		title: "Invalid ClickHouse settings",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** Maple could not load or persist the organization's ClickHouse settings. */
export class OrgClickHouseSettingsPersistenceError extends HttpTaggedError<OrgClickHouseSettingsPersistenceError>()(
	"@maple/http/errors/OrgClickHouseSettingsPersistenceError",
	{ message: Schema.String },
	{
		status: 503,
		code: "clickhouse_settings_unavailable",
		title: "ClickHouse settings are temporarily unavailable",
		message: "ClickHouse settings are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

/** Maple could not decrypt the organization's saved ClickHouse credentials. */
export class OrgClickHouseSettingsEncryptionError extends HttpTaggedError<OrgClickHouseSettingsEncryptionError>()(
	"@maple/http/errors/OrgClickHouseSettingsEncryptionError",
	{ message: Schema.String },
	{
		status: 500,
		code: "clickhouse_settings_encryption_failed",
		title: "Maple could not read these settings",
		message: "Maple could not securely read the saved ClickHouse settings.",
		retry: "never",
		recovery: "contact_support",
		exposure: "redacted",
	},
) {}

/** Saved settings no longer satisfy the runtime connection invariants. */
export class OrgClickHouseSettingsStoredConfigInvalidError extends HttpTaggedError<OrgClickHouseSettingsStoredConfigInvalidError>()(
	"@maple/http/errors/OrgClickHouseSettingsStoredConfigInvalidError",
	{ message: Schema.String, cause: Schema.Defect() },
	{
		status: 502,
		code: "clickhouse_stored_settings_invalid",
		title: "Saved ClickHouse settings are invalid",
		message: "The saved ClickHouse settings are invalid. Reconnect the database in settings.",
		retry: "never",
		recovery: "reconnect",
		exposure: "redacted",
	},
) {}

/** ClickHouse accepted the request but rejected the supplied connection settings. */
export class OrgClickHouseSettingsUpstreamRejectedError extends HttpTaggedError<OrgClickHouseSettingsUpstreamRejectedError>()(
	"@maple/http/errors/OrgClickHouseSettingsUpstreamRejectedError",
	{
		message: Schema.String,
		statusCode: Schema.NullOr(Schema.Number),
	},
	{
		status: 400,
		code: "clickhouse_connection_rejected",
		title: "ClickHouse rejected the connection",
		retry: "never",
		recovery: "reconnect",
		exposure: "public_message",
	},
) {}

/** The configured ClickHouse service could not be reached. */
export class OrgClickHouseSettingsUpstreamUnavailableError extends HttpTaggedError<OrgClickHouseSettingsUpstreamUnavailableError>()(
	"@maple/http/errors/OrgClickHouseSettingsUpstreamUnavailableError",
	{
		message: Schema.String,
		statusCode: Schema.NullOr(Schema.Number),
	},
	{
		status: 503,
		code: "clickhouse_connection_unavailable",
		title: "ClickHouse is temporarily unavailable",
		message: "The configured ClickHouse service is temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}
