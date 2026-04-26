import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"

export class HazelIntegrationStatus extends Schema.Class<HazelIntegrationStatus>(
  "HazelIntegrationStatus",
)({
  connected: Schema.Boolean,
  externalUserId: Schema.NullOr(Schema.String),
  externalUserEmail: Schema.NullOr(Schema.String),
  connectedByUserId: Schema.NullOr(Schema.String),
  scope: Schema.NullOr(Schema.String),
}) {}

export class HazelWorkspaceSummary extends Schema.Class<HazelWorkspaceSummary>(
  "HazelWorkspaceSummary",
)({
  id: Schema.String,
  name: Schema.String,
}) {}

export class HazelWorkspacesListResponse extends Schema.Class<HazelWorkspacesListResponse>(
  "HazelWorkspacesListResponse",
)({
  workspaces: Schema.Array(HazelWorkspaceSummary),
}) {}

export class HazelStartConnectRequest extends Schema.Class<HazelStartConnectRequest>(
  "HazelStartConnectRequest",
)({
  returnTo: Schema.optional(Schema.String),
}) {}

export class HazelStartConnectResponse extends Schema.Class<HazelStartConnectResponse>(
  "HazelStartConnectResponse",
)({
  redirectUrl: Schema.String,
  state: Schema.String,
}) {}

export class HazelDisconnectResponse extends Schema.Class<HazelDisconnectResponse>(
  "HazelDisconnectResponse",
)({
  disconnected: Schema.Boolean,
}) {}

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
    status: Schema.optional(Schema.Number),
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
    HttpApiEndpoint.get("hazelWorkspaces", "/hazel/workspaces", {
      success: HazelWorkspacesListResponse,
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
