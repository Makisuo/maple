import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"

const IntegrationPath = Schema.Struct({
  integrationId: Schema.String,
})

export class GitHubRepoInfo extends Schema.Class<GitHubRepoInfo>("GitHubRepoInfo")({
  id: Schema.Number,
  fullName: Schema.String,
  owner: Schema.String,
  name: Schema.String,
}) {}

export class ServiceRepoMapping extends Schema.Class<ServiceRepoMapping>("ServiceRepoMapping")({
  serviceName: Schema.String,
  repoFullName: Schema.String,
}) {}

export class GitHubIntegrationResponse extends Schema.Class<GitHubIntegrationResponse>(
  "GitHubIntegrationResponse",
)({
  id: Schema.String,
  orgId: Schema.String,
  installationId: Schema.Number,
  githubAccountLogin: Schema.String,
  githubAccountType: Schema.String,
  selectedRepos: Schema.Array(GitHubRepoInfo),
  serviceRepoMappings: Schema.Array(ServiceRepoMapping),
  defaultRepo: Schema.NullOr(GitHubRepoInfo),
  enabled: Schema.Boolean,
  status: Schema.String,
  lastSyncAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

export class GitHubIntegrationsListResponse extends Schema.Class<GitHubIntegrationsListResponse>(
  "GitHubIntegrationsListResponse",
)({
  integrations: Schema.Array(GitHubIntegrationResponse),
}) {}

export class ConnectGitHubRequest extends Schema.Class<ConnectGitHubRequest>(
  "ConnectGitHubRequest",
)({
  installationId: Schema.Number,
  setupAction: Schema.String, // "install" | "update"
}) {}

export class UpdateGitHubIntegrationRequest extends Schema.Class<UpdateGitHubIntegrationRequest>(
  "UpdateGitHubIntegrationRequest",
)({
  selectedRepos: Schema.optional(Schema.Array(GitHubRepoInfo)),
  serviceRepoMappings: Schema.optional(Schema.Array(ServiceRepoMapping)),
  defaultRepo: Schema.optional(Schema.NullOr(GitHubRepoInfo)),
  enabled: Schema.optional(Schema.Boolean),
}) {}

export class GitHubRepoResponse extends Schema.Class<GitHubRepoResponse>(
  "GitHubRepoResponse",
)({
  id: Schema.Number,
  fullName: Schema.String,
  private: Schema.Boolean,
  defaultBranch: Schema.String,
  owner: Schema.String,
  name: Schema.String,
}) {}

export class GitHubReposListResponse extends Schema.Class<GitHubReposListResponse>(
  "GitHubReposListResponse",
)({
  repos: Schema.Array(GitHubRepoResponse),
}) {}

export class GitHubIntegrationDeleteResponse extends Schema.Class<GitHubIntegrationDeleteResponse>(
  "GitHubIntegrationDeleteResponse",
)({
  id: Schema.String,
}) {}

export class GitHubIntegrationError extends Schema.TaggedError<GitHubIntegrationError>()(
  "GitHubIntegrationError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 503 }),
) {}

export class GitHubIntegrationNotFoundError extends Schema.TaggedError<GitHubIntegrationNotFoundError>()(
  "GitHubIntegrationNotFoundError",
  {
    integrationId: Schema.String,
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 404 }),
) {}

export class GitHubIntegrationValidationError extends Schema.TaggedError<GitHubIntegrationValidationError>()(
  "GitHubIntegrationValidationError",
  {
    message: Schema.String,
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class GitHubIntegrationsApiGroup extends HttpApiGroup.make("githubIntegrations")
  .add(
    HttpApiEndpoint.get("list", "/")
      .addSuccess(GitHubIntegrationsListResponse)
      .addError(GitHubIntegrationError),
  )
  .add(
    HttpApiEndpoint.post("connect", "/callback")
      .setPayload(ConnectGitHubRequest)
      .addSuccess(GitHubIntegrationResponse)
      .addError(GitHubIntegrationError)
      .addError(GitHubIntegrationValidationError),
  )
  .add(
    HttpApiEndpoint.get("listRepos", "/repos")
      .addSuccess(GitHubReposListResponse)
      .addError(GitHubIntegrationError)
      .addError(GitHubIntegrationNotFoundError),
  )
  .add(
    HttpApiEndpoint.patch("update", "/:integrationId")
      .setPath(IntegrationPath)
      .setPayload(UpdateGitHubIntegrationRequest)
      .addSuccess(GitHubIntegrationResponse)
      .addError(GitHubIntegrationNotFoundError)
      .addError(GitHubIntegrationError),
  )
  .add(
    HttpApiEndpoint.del("delete", "/:integrationId")
      .setPath(IntegrationPath)
      .addSuccess(GitHubIntegrationDeleteResponse)
      .addError(GitHubIntegrationNotFoundError)
      .addError(GitHubIntegrationError),
  )
  .prefix("/api/github")
  .middleware(Authorization) {}
