import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"
import { IsoDateTimeString } from "../primitives"

export const OrgTinybirdSyncStatus = Schema.Literals(["active", "error", "out_of_sync"])
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

export class OrgTinybirdDeploymentStatusResponse extends Schema.Class<OrgTinybirdDeploymentStatusResponse>(
  "OrgTinybirdDeploymentStatusResponse",
)({
  hasDeployment: Schema.Boolean,
  deploymentId: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  isTerminal: Schema.NullOr(Schema.Boolean),
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

export class OrgTinybirdSettingsSyncError extends Schema.TaggedErrorClass<OrgTinybirdSettingsSyncError>()(
  "@maple/http/errors/OrgTinybirdSettingsSyncError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 502 },
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
        OrgTinybirdSettingsSyncError,
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
        OrgTinybirdSettingsSyncError,
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
        OrgTinybirdSettingsSyncError,
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
        OrgTinybirdSettingsSyncError,
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
