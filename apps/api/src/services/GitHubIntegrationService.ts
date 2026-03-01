import { randomUUID } from "node:crypto"
import { createSign } from "node:crypto"
import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite"
import {
  GitHubIntegrationError,
  GitHubIntegrationNotFoundError,
  GitHubIntegrationResponse,
  GitHubIntegrationValidationError,
  GitHubRepoResponse,
  type ConnectGitHubRequest,
  GitHubRepoInfo,
  ServiceRepoMapping,
  type UpdateGitHubIntegrationRequest,
} from "@maple/domain/http"
import { githubIntegrations } from "@maple/db"
import { and, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { DatabaseLive } from "./DatabaseLive"
import { Env } from "./Env"

const toPersistenceError = (error: unknown) =>
  new GitHubIntegrationError({
    message:
      error instanceof Error ? error.message : "GitHub integration persistence failed",
  })

function createAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      iat: now - 60,
      exp: now + 600,
      iss: appId,
    }),
  ).toString("base64url")

  const sign = createSign("RSA-SHA256")
  sign.update(`${header}.${payload}`)
  const signature = sign.sign(privateKey, "base64url")

  return `${header}.${payload}.${signature}`
}

function rowToResponse(row: typeof githubIntegrations.$inferSelect): GitHubIntegrationResponse {
  let repos: GitHubRepoInfo[] = []
  try {
    repos = (JSON.parse(row.selectedRepos) as Array<{ id: number; fullName: string; owner: string; name: string }>).map(
      (r) => new GitHubRepoInfo(r),
    )
  } catch {
    repos = []
  }

  let mappings: ServiceRepoMapping[] = []
  try {
    mappings = (JSON.parse(row.serviceRepoMappings) as Array<{ serviceName: string; repoFullName: string }>).map(
      (m) => new ServiceRepoMapping(m),
    )
  } catch {
    mappings = []
  }

  let defaultRepo: GitHubRepoInfo | null = null
  try {
    if (row.defaultRepo) {
      defaultRepo = new GitHubRepoInfo(JSON.parse(row.defaultRepo))
    }
  } catch {
    defaultRepo = null
  }

  return new GitHubIntegrationResponse({
    id: row.id,
    orgId: row.orgId,
    installationId: row.installationId,
    githubAccountLogin: row.githubAccountLogin,
    githubAccountType: row.githubAccountType,
    selectedRepos: repos,
    serviceRepoMappings: mappings,
    defaultRepo,
    enabled: row.enabled === 1,
    status: row.status,
    lastSyncAt: row.lastSyncAt ? new Date(row.lastSyncAt).toISOString() : null,
    lastError: row.lastError,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  })
}

export class GitHubIntegrationService extends Effect.Service<GitHubIntegrationService>()(
  "GitHubIntegrationService",
  {
    accessors: true,
    dependencies: [Env.Default],
    effect: Effect.gen(function* () {
      const db = yield* SqliteDrizzle
      const env = yield* Env

      const getInstallationToken = Effect.fn("GitHubIntegrationService.getInstallationToken")(
        function* (installationId: number) {
          if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
            return yield* Effect.fail(
              new GitHubIntegrationError({
                message: "GitHub App is not configured (missing GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY)",
              }),
            )
          }

          const jwt = yield* Effect.try({
            try: () => createAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY),
            catch: (error) =>
              new GitHubIntegrationError({
                message: `Failed to create GitHub App JWT: ${error instanceof Error ? error.message : "unknown error"}`,
              }),
          })

          const result = yield* Effect.tryPromise({
            try: async () => {
              const response = await fetch(
                `https://api.github.com/app/installations/${installationId}/access_tokens`,
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${jwt}`,
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                  },
                },
              )
              if (!response.ok) {
                const body = await response.text()
                throw new Error(`GitHub API ${response.status}: ${body}`)
              }
              return (await response.json()) as { token: string; expires_at: string }
            },
            catch: (error) =>
              new GitHubIntegrationError({
                message: `Failed to get installation token: ${error instanceof Error ? error.message : "unknown error"}`,
              }),
          })

          return result.token
        },
      )

      const getInstallationInfo = Effect.fn("GitHubIntegrationService.getInstallationInfo")(
        function* (installationId: number) {
          if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
            return yield* Effect.fail(
              new GitHubIntegrationError({
                message: "GitHub App is not configured",
              }),
            )
          }

          const jwt = yield* Effect.try({
            try: () => createAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY),
            catch: (error) =>
              new GitHubIntegrationError({
                message: `Failed to create GitHub App JWT: ${error instanceof Error ? error.message : "unknown error"}`,
              }),
          })

          const result = yield* Effect.tryPromise({
            try: async () => {
              const response = await fetch(
                `https://api.github.com/app/installations/${installationId}`,
                {
                  method: "GET",
                  headers: {
                    Authorization: `Bearer ${jwt}`,
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                  },
                },
              )
              if (!response.ok) {
                const body = await response.text()
                throw new Error(`GitHub API ${response.status}: ${body}`)
              }
              return (await response.json()) as {
                id: number
                account: { login: string; type: string }
              }
            },
            catch: (error) =>
              new GitHubIntegrationError({
                message: `Failed to get installation info: ${error instanceof Error ? error.message : "unknown error"}`,
              }),
          })

          return result
        },
      )

      const handleCallback = Effect.fn("GitHubIntegrationService.handleCallback")(
        function* (orgId: string, request: ConnectGitHubRequest) {
          const installationInfo = yield* getInstallationInfo(request.installationId)

          // Check if integration already exists for this installation
          const existing = yield* db
            .select()
            .from(githubIntegrations)
            .where(
              and(
                eq(githubIntegrations.orgId, orgId),
                eq(githubIntegrations.installationId, request.installationId),
              ),
            )
            .limit(1)
            .pipe(Effect.mapError(toPersistenceError))

          const now = Date.now()

          if (existing[0]) {
            // Update existing integration
            yield* db
              .update(githubIntegrations)
              .set({
                githubAccountLogin: installationInfo.account.login,
                githubAccountType: installationInfo.account.type,
                status: "connected",
                lastError: null,
                updatedAt: now,
              })
              .where(eq(githubIntegrations.id, existing[0].id))
              .pipe(Effect.mapError(toPersistenceError))

            const rows = yield* db
              .select()
              .from(githubIntegrations)
              .where(eq(githubIntegrations.id, existing[0].id))
              .limit(1)
              .pipe(Effect.mapError(toPersistenceError))

            if (!rows[0]) {
              return yield* Effect.fail(
                new GitHubIntegrationError({ message: "Failed to load updated integration" }),
              )
            }

            return rowToResponse(rows[0])
          }

          // Create new integration
          const id = randomUUID()
          yield* db
            .insert(githubIntegrations)
            .values({
              id,
              orgId,
              installationId: request.installationId,
              githubAccountLogin: installationInfo.account.login,
              githubAccountType: installationInfo.account.type,
              selectedRepos: "[]",
              enabled: 1,
              status: "connected",
              createdAt: now,
              updatedAt: now,
            })
            .pipe(Effect.mapError(toPersistenceError))

          const rows = yield* db
            .select()
            .from(githubIntegrations)
            .where(eq(githubIntegrations.id, id))
            .limit(1)
            .pipe(Effect.mapError(toPersistenceError))

          if (!rows[0]) {
            return yield* Effect.fail(
              new GitHubIntegrationError({ message: "Failed to create integration" }),
            )
          }

          return rowToResponse(rows[0])
        },
      )

      const list = Effect.fn("GitHubIntegrationService.list")(function* (orgId: string) {
        const rows = yield* db
          .select()
          .from(githubIntegrations)
          .where(eq(githubIntegrations.orgId, orgId))
          .pipe(Effect.mapError(toPersistenceError))

        return rows.map(rowToResponse)
      })

      const listAccessibleRepos = Effect.fn("GitHubIntegrationService.listAccessibleRepos")(
        function* (orgId: string) {
          // Find the first integration for this org
          const rows = yield* db
            .select()
            .from(githubIntegrations)
            .where(eq(githubIntegrations.orgId, orgId))
            .limit(1)
            .pipe(Effect.mapError(toPersistenceError))

          const integration = rows[0]
          if (!integration) {
            return yield* Effect.fail(
              new GitHubIntegrationNotFoundError({
                integrationId: "",
                message: "No GitHub integration found for this organization",
              }),
            )
          }

          const token = yield* getInstallationToken(integration.installationId)

          const result = yield* Effect.tryPromise({
            try: async () => {
              const response = await fetch(
                "https://api.github.com/installation/repositories?per_page=100",
                {
                  headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                  },
                },
              )
              if (!response.ok) {
                const body = await response.text()
                throw new Error(`GitHub API ${response.status}: ${body}`)
              }
              return (await response.json()) as {
                repositories: Array<{
                  id: number
                  full_name: string
                  private: boolean
                  default_branch: string
                  owner: { login: string }
                  name: string
                }>
              }
            },
            catch: (error) =>
              new GitHubIntegrationError({
                message: `Failed to list repos: ${error instanceof Error ? error.message : "unknown error"}`,
              }),
          })

          return result.repositories.map(
            (repo) =>
              new GitHubRepoResponse({
                id: repo.id,
                fullName: repo.full_name,
                private: repo.private,
                defaultBranch: repo.default_branch,
                owner: repo.owner.login,
                name: repo.name,
              }),
          )
        },
      )

      const update = Effect.fn("GitHubIntegrationService.update")(function* (
        orgId: string,
        integrationId: string,
        request: UpdateGitHubIntegrationRequest,
      ) {
        const existing = yield* db
          .select()
          .from(githubIntegrations)
          .where(
            and(
              eq(githubIntegrations.orgId, orgId),
              eq(githubIntegrations.id, integrationId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError(toPersistenceError))

        if (!existing[0]) {
          return yield* Effect.fail(
            new GitHubIntegrationNotFoundError({
              integrationId,
              message: "GitHub integration not found",
            }),
          )
        }

        const now = Date.now()
        const updates: Record<string, unknown> = { updatedAt: now }

        if (request.selectedRepos !== undefined) {
          updates.selectedRepos = JSON.stringify(request.selectedRepos)
        }
        if (request.serviceRepoMappings !== undefined) {
          updates.serviceRepoMappings = JSON.stringify(request.serviceRepoMappings)
        }
        if (request.defaultRepo !== undefined) {
          updates.defaultRepo = request.defaultRepo ? JSON.stringify(request.defaultRepo) : null
        }
        if (request.enabled !== undefined) {
          updates.enabled = request.enabled ? 1 : 0
        }

        yield* db
          .update(githubIntegrations)
          .set(updates)
          .where(
            and(
              eq(githubIntegrations.orgId, orgId),
              eq(githubIntegrations.id, integrationId),
            ),
          )
          .pipe(Effect.mapError(toPersistenceError))

        const rows = yield* db
          .select()
          .from(githubIntegrations)
          .where(eq(githubIntegrations.id, integrationId))
          .limit(1)
          .pipe(Effect.mapError(toPersistenceError))

        if (!rows[0]) {
          return yield* Effect.fail(
            new GitHubIntegrationError({ message: "Failed to load updated integration" }),
          )
        }

        return rowToResponse(rows[0])
      })

      const remove = Effect.fn("GitHubIntegrationService.delete")(function* (
        orgId: string,
        integrationId: string,
      ) {
        const rows = yield* db
          .delete(githubIntegrations)
          .where(
            and(
              eq(githubIntegrations.orgId, orgId),
              eq(githubIntegrations.id, integrationId),
            ),
          )
          .returning({ id: githubIntegrations.id })
          .pipe(Effect.mapError(toPersistenceError))

        const deleted = rows[0]

        if (!deleted) {
          return yield* Effect.fail(
            new GitHubIntegrationNotFoundError({
              integrationId,
              message: "GitHub integration not found",
            }),
          )
        }

        return { id: deleted.id }
      })

      const listAllActive = Effect.fn("GitHubIntegrationService.listAllActive")(function* () {
        const rows = yield* db
          .select()
          .from(githubIntegrations)
          .where(eq(githubIntegrations.enabled, 1))
          .pipe(Effect.mapError(toPersistenceError))

        return rows
      })

      return {
        handleCallback,
        list,
        getInstallationToken,
        listAccessibleRepos,
        update,
        delete: remove,
        listAllActive,
      }
    }),
  },
) {
  static readonly Live = this.Default.pipe(Layer.provide(DatabaseLive))
}
