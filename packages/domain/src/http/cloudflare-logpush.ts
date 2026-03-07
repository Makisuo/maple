import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { Authorization } from "./current-tenant";

const CloudflareLogpushConnectorPath = Schema.Struct({
  connectorId: Schema.String,
});

export class CloudflareLogpushConnectorResponse extends Schema.Class<CloudflareLogpushConnectorResponse>(
  "CloudflareLogpushConnectorResponse",
)({
  id: Schema.String,
  name: Schema.String,
  zoneName: Schema.String,
  serviceName: Schema.String,
  dataset: Schema.String,
  enabled: Schema.Boolean,
  lastReceivedAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  secretRotatedAt: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

export class CloudflareLogpushListResponse extends Schema.Class<CloudflareLogpushListResponse>(
  "CloudflareLogpushListResponse",
)({
  connectors: Schema.Array(CloudflareLogpushConnectorResponse),
}) {}

export class CloudflareLogpushSetupResponse extends Schema.Class<CloudflareLogpushSetupResponse>(
  "CloudflareLogpushSetupResponse",
)({
  connectorId: Schema.String,
  dataset: Schema.String,
  endpointUrl: Schema.String,
  headerName: Schema.String,
  secret: Schema.String,
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
  id: Schema.String,
}) {}

export class CreateCloudflareLogpushConnectorRequest extends Schema.Class<CreateCloudflareLogpushConnectorRequest>(
  "CreateCloudflareLogpushConnectorRequest",
)({
  name: Schema.String,
  zoneName: Schema.String,
  serviceName: Schema.optional(Schema.NullOr(Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
}) {}

export class UpdateCloudflareLogpushConnectorRequest extends Schema.Class<UpdateCloudflareLogpushConnectorRequest>(
  "UpdateCloudflareLogpushConnectorRequest",
)({
  name: Schema.optional(Schema.String),
  zoneName: Schema.optional(Schema.String),
  serviceName: Schema.optional(Schema.NullOr(Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
}) {}

export class CloudflareLogpushPersistenceError extends Schema.TaggedError<CloudflareLogpushPersistenceError>()(
  "CloudflareLogpushPersistenceError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 503 }),
) {}

export class CloudflareLogpushNotFoundError extends Schema.TaggedError<CloudflareLogpushNotFoundError>()(
  "CloudflareLogpushNotFoundError",
  {
    connectorId: Schema.String,
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 404 }),
) {}

export class CloudflareLogpushValidationError extends Schema.TaggedError<CloudflareLogpushValidationError>()(
  "CloudflareLogpushValidationError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class CloudflareLogpushEncryptionError extends Schema.TaggedError<CloudflareLogpushEncryptionError>()(
  "CloudflareLogpushEncryptionError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 500 }),
) {}

export class CloudflareLogpushApiGroup extends HttpApiGroup.make(
  "cloudflareLogpush",
)
  .add(
    HttpApiEndpoint.get("list", "/connectors")
      .addSuccess(CloudflareLogpushListResponse)
      .addError(CloudflareLogpushPersistenceError),
  )
  .add(
    HttpApiEndpoint.post("create", "/connectors")
      .setPayload(CreateCloudflareLogpushConnectorRequest)
      .addSuccess(CloudflareLogpushCreateResponse)
      .addError(CloudflareLogpushValidationError)
      .addError(CloudflareLogpushPersistenceError)
      .addError(CloudflareLogpushEncryptionError),
  )
  .add(
    HttpApiEndpoint.patch("update", "/connectors/:connectorId")
      .setPath(CloudflareLogpushConnectorPath)
      .setPayload(UpdateCloudflareLogpushConnectorRequest)
      .addSuccess(CloudflareLogpushConnectorResponse)
      .addError(CloudflareLogpushNotFoundError)
      .addError(CloudflareLogpushValidationError)
      .addError(CloudflareLogpushPersistenceError),
  )
  .add(
    HttpApiEndpoint.del("delete", "/connectors/:connectorId")
      .setPath(CloudflareLogpushConnectorPath)
      .addSuccess(CloudflareLogpushDeleteResponse)
      .addError(CloudflareLogpushNotFoundError)
      .addError(CloudflareLogpushPersistenceError),
  )
  .add(
    HttpApiEndpoint.get("getSetup", "/connectors/:connectorId/setup")
      .setPath(CloudflareLogpushConnectorPath)
      .addSuccess(CloudflareLogpushSetupResponse)
      .addError(CloudflareLogpushNotFoundError)
      .addError(CloudflareLogpushPersistenceError)
      .addError(CloudflareLogpushEncryptionError),
  )
  .add(
    HttpApiEndpoint.post(
      "rotateSecret",
      "/connectors/:connectorId/rotate-secret",
    )
      .setPath(CloudflareLogpushConnectorPath)
      .addSuccess(CloudflareLogpushSetupResponse)
      .addError(CloudflareLogpushNotFoundError)
      .addError(CloudflareLogpushPersistenceError)
      .addError(CloudflareLogpushEncryptionError),
  )
  .prefix("/api/cloudflare-logpush")
  .middleware(Authorization) {}
