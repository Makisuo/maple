import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"
import { IsoDateTimeString } from "../primitives"

export class OrgOpenrouterSettingsResponse extends Schema.Class<OrgOpenrouterSettingsResponse>(
	"OrgOpenrouterSettingsResponse",
)({
	configured: Schema.Boolean,
	last4: Schema.NullOr(Schema.String),
	updatedAt: Schema.NullOr(IsoDateTimeString),
}) {}

export class OrgOpenrouterSettingsUpsertRequest extends Schema.Class<OrgOpenrouterSettingsUpsertRequest>(
	"OrgOpenrouterSettingsUpsertRequest",
)({
	apiKey: Schema.String,
}) {}

export class OrgOpenrouterSettingsDeleteResponse extends Schema.Class<OrgOpenrouterSettingsDeleteResponse>(
	"OrgOpenrouterSettingsDeleteResponse",
)({
	configured: Schema.Literal(false),
}) {}

export class OrgOpenrouterSettingsForbiddenError extends Schema.TaggedErrorClass<OrgOpenrouterSettingsForbiddenError>()(
	"@maple/http/errors/OrgOpenrouterSettingsForbiddenError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 403 },
) {}

export class OrgOpenrouterSettingsValidationError extends Schema.TaggedErrorClass<OrgOpenrouterSettingsValidationError>()(
	"@maple/http/errors/OrgOpenrouterSettingsValidationError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class OrgOpenrouterSettingsPersistenceError extends Schema.TaggedErrorClass<OrgOpenrouterSettingsPersistenceError>()(
	"@maple/http/errors/OrgOpenrouterSettingsPersistenceError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 503 },
) {}

export class OrgOpenrouterSettingsEncryptionError extends Schema.TaggedErrorClass<OrgOpenrouterSettingsEncryptionError>()(
	"@maple/http/errors/OrgOpenrouterSettingsEncryptionError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 500 },
) {}

export class OrgOpenrouterSettingsApiGroup extends HttpApiGroup.make("orgOpenrouterSettings")
	.add(
		HttpApiEndpoint.get("get", "/", {
			success: OrgOpenrouterSettingsResponse,
			error: [OrgOpenrouterSettingsForbiddenError, OrgOpenrouterSettingsPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.put("upsert", "/", {
			payload: OrgOpenrouterSettingsUpsertRequest,
			success: OrgOpenrouterSettingsResponse,
			error: [
				OrgOpenrouterSettingsForbiddenError,
				OrgOpenrouterSettingsValidationError,
				OrgOpenrouterSettingsPersistenceError,
				OrgOpenrouterSettingsEncryptionError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/", {
			success: OrgOpenrouterSettingsDeleteResponse,
			error: [OrgOpenrouterSettingsForbiddenError, OrgOpenrouterSettingsPersistenceError],
		}),
	)
	.prefix("/api/org-openrouter-settings")
	.middleware(Authorization) {}
