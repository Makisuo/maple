import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"
import { IsoDateTimeString } from "../primitives"

export const OrgTinybirdSyncStatus = Schema.Literal("active", "error", "out_of_sync")
export type OrgTinybirdSyncStatus = Schema.Schema.Type<typeof OrgTinybirdSyncStatus>

export class OrgTinybirdSettingsResponse extends Schema.Class<OrgTinybirdSettingsResponse>(
  "OrgTinybirdSettingsResponse",
)({
  configured: Schema.Boolean,
  host: Schema.NullOr(Schema.String),
  syncStatus: Schema.NullOr(OrgTinybirdSyncStatus),
  lastSyncAt: Schema.NullOr(IsoDateTimeString),
  lastSyncError: Schema.NullOr(Schema.String),
  projectRevision: Schema.NullOr(Schema.String),
}) {}

export class OrgTinybirdSettingsUpsertRequest extends Schema.Class<OrgTinybirdSettingsUpsertRequest>(
  "OrgTinybirdSettingsUpsertRequest",
)({
  host: Schema.String,
  token: Schema.String,
}) {}

export class OrgTinybirdSettingsDeleteResponse extends Schema.Class<OrgTinybirdSettingsDeleteResponse>(
  "OrgTinybirdSettingsDeleteResponse",
)({
  configured: Schema.Literal(false),
}) {}

export class OrgTinybirdSettingsForbiddenError extends Schema.TaggedError<OrgTinybirdSettingsForbiddenError>()(
  "OrgTinybirdSettingsForbiddenError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 403 }),
) {}

export class OrgTinybirdSettingsValidationError extends Schema.TaggedError<OrgTinybirdSettingsValidationError>()(
  "OrgTinybirdSettingsValidationError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class OrgTinybirdSettingsPersistenceError extends Schema.TaggedError<OrgTinybirdSettingsPersistenceError>()(
  "OrgTinybirdSettingsPersistenceError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 503 }),
) {}

export class OrgTinybirdSettingsEncryptionError extends Schema.TaggedError<OrgTinybirdSettingsEncryptionError>()(
  "OrgTinybirdSettingsEncryptionError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 500 }),
) {}

export class OrgTinybirdSettingsSyncError extends Schema.TaggedError<OrgTinybirdSettingsSyncError>()(
  "OrgTinybirdSettingsSyncError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 502 }),
) {}

export class OrgTinybirdSettingsApiGroup extends HttpApiGroup.make("orgTinybirdSettings")
  .add(
    HttpApiEndpoint.get("get", "/")
      .addSuccess(OrgTinybirdSettingsResponse)
      .addError(OrgTinybirdSettingsForbiddenError)
      .addError(OrgTinybirdSettingsPersistenceError),
  )
  .add(
    HttpApiEndpoint.put("upsert", "/")
      .setPayload(OrgTinybirdSettingsUpsertRequest)
      .addSuccess(OrgTinybirdSettingsResponse)
      .addError(OrgTinybirdSettingsForbiddenError)
      .addError(OrgTinybirdSettingsValidationError)
      .addError(OrgTinybirdSettingsPersistenceError)
      .addError(OrgTinybirdSettingsEncryptionError)
      .addError(OrgTinybirdSettingsSyncError),
  )
  .add(
    HttpApiEndpoint.post("resync", "/resync")
      .addSuccess(OrgTinybirdSettingsResponse)
      .addError(OrgTinybirdSettingsForbiddenError)
      .addError(OrgTinybirdSettingsValidationError)
      .addError(OrgTinybirdSettingsPersistenceError)
      .addError(OrgTinybirdSettingsEncryptionError)
      .addError(OrgTinybirdSettingsSyncError),
  )
  .add(
    HttpApiEndpoint.del("delete", "/")
      .addSuccess(OrgTinybirdSettingsDeleteResponse)
      .addError(OrgTinybirdSettingsForbiddenError)
      .addError(OrgTinybirdSettingsPersistenceError),
  )
  .prefix("/api/org-tinybird-settings")
  .middleware(Authorization) {}
