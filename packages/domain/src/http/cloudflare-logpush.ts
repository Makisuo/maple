import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import {
  CloudflareLogpushConnectorId,
  IsoDateTimeString,
} from "../primitives";
import { Authorization } from "./current-tenant";

export class CloudflareLogpushConnectorResponse extends Schema.Class<CloudflareLogpushConnectorResponse>(
  "CloudflareLogpushConnectorResponse",
)({
  id: CloudflareLogpushConnectorId,
  name: Schema.String,
  zoneName: Schema.String,
  serviceName: Schema.String,
  dataset: Schema.String,
  enabled: Schema.Boolean,
  lastReceivedAt: Schema.NullOr(IsoDateTimeString),
  lastError: Schema.NullOr(Schema.String),
  secretRotatedAt: IsoDateTimeString,
  createdAt: IsoDateTimeString,
  updatedAt: IsoDateTimeString,
}) {}

export class CloudflareLogpushListResponse extends Schema.Class<CloudflareLogpushListResponse>(
  "CloudflareLogpushListResponse",
)({
  connectors: Schema.Array(CloudflareLogpushConnectorResponse),
}) {}

export class CloudflareLogpushSetupResponse extends Schema.Class<CloudflareLogpushSetupResponse>(
  "CloudflareLogpushSetupResponse",
)({
  connectorId: CloudflareLogpushConnectorId,
  dataset: Schema.String,
  destinationConf: Schema.String,
  recommendedOutputType: Schema.String,
  recommendedTimestampFormat: Schema.String,
  recommendedFieldNames: Schema.Array(Schema.String),
  validationNote: Schema.String,
  cloudflareSetupSteps: Schema.Array(Schema.String),
}) {}

export class CloudflareLogpushCreateResponse extends Schema.Class<CloudflareLogpushCreateResponse>(
  "CloudflareLogpushCreateResponse",
)({
  connector: CloudflareLogpushConnectorResponse,
  setup: CloudflareLogpushSetupResponse,
}) {}

export class CloudflareLogpushDeleteResponse extends Schema.Class<CloudflareLogpushDeleteResponse>(
  "CloudflareLogpushDeleteResponse",
)({
  id: CloudflareLogpushConnectorId,
}) {}

export class CreateCloudflareLogpushConnectorRequest extends Schema.Class<CreateCloudflareLogpushConnectorRequest>(
  "CreateCloudflareLogpushConnectorRequest",
)({
  name: Schema.String,
  zoneName: Schema.String,
  serviceName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class UpdateCloudflareLogpushConnectorRequest extends Schema.Class<UpdateCloudflareLogpushConnectorRequest>(
  "UpdateCloudflareLogpushConnectorRequest",
)({
  name: Schema.optionalKey(Schema.String),
  zoneName: Schema.optionalKey(Schema.String),
  serviceName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class CloudflareLogpushPersistenceError extends Schema.TaggedErrorClass<CloudflareLogpushPersistenceError>()(
  "CloudflareLogpushPersistenceError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

export class CloudflareLogpushNotFoundError extends Schema.TaggedErrorClass<CloudflareLogpushNotFoundError>()(
  "CloudflareLogpushNotFoundError",
  {
    connectorId: CloudflareLogpushConnectorId,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class CloudflareLogpushValidationError extends Schema.TaggedErrorClass<CloudflareLogpushValidationError>()(
  "CloudflareLogpushValidationError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class CloudflareLogpushEncryptionError extends Schema.TaggedErrorClass<CloudflareLogpushEncryptionError>()(
  "CloudflareLogpushEncryptionError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

export class CloudflareLogpushApiGroup extends HttpApiGroup.make(
  "cloudflareLogpush",
)
  .add(
    HttpApiEndpoint.get("list", "/connectors", {
      success: CloudflareLogpushListResponse,
      error: CloudflareLogpushPersistenceError,
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/connectors", {
      payload: CreateCloudflareLogpushConnectorRequest,
      success: CloudflareLogpushCreateResponse,
      error: [
        CloudflareLogpushValidationError,
        CloudflareLogpushPersistenceError,
        CloudflareLogpushEncryptionError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/connectors/:connectorId", {
      params: {
        connectorId: CloudflareLogpushConnectorId,
      },
      payload: UpdateCloudflareLogpushConnectorRequest,
      success: CloudflareLogpushConnectorResponse,
      error: [
        CloudflareLogpushNotFoundError,
        CloudflareLogpushValidationError,
        CloudflareLogpushPersistenceError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.delete("delete", "/connectors/:connectorId", {
      params: {
        connectorId: CloudflareLogpushConnectorId,
      },
      success: CloudflareLogpushDeleteResponse,
      error: [CloudflareLogpushNotFoundError, CloudflareLogpushPersistenceError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getSetup", "/connectors/:connectorId/setup", {
      params: {
        connectorId: CloudflareLogpushConnectorId,
      },
      success: CloudflareLogpushSetupResponse,
      error: [
        CloudflareLogpushNotFoundError,
        CloudflareLogpushPersistenceError,
        CloudflareLogpushEncryptionError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("rotateSecret", "/connectors/:connectorId/rotate-secret", {
      params: {
        connectorId: CloudflareLogpushConnectorId,
      },
      success: CloudflareLogpushSetupResponse,
      error: [
        CloudflareLogpushNotFoundError,
        CloudflareLogpushPersistenceError,
        CloudflareLogpushEncryptionError,
      ],
    }),
  )
  .prefix("/api/cloudflare-logpush")
  .middleware(Authorization) {}
