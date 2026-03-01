import { SqliteDrizzle } from "@effect/sql-drizzle/Sqlite"
import { githubIntegrations } from "@maple/db"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { AnomalyDetectionService } from "./services/AnomalyDetectionService"
import { AnomalyStateService } from "./services/AnomalyStateService"
import { GitHubIssueService } from "./services/GitHubIssueService"

interface RepoInfo {
  id: number
  fullName: string
  owner: string
  name: string
}

interface ServiceRepoMappingEntry {
  serviceName: string
  repoFullName: string
}

function parseRepoFullName(fullName: string): { owner: string; name: string } {
  const [owner, name] = fullName.split("/")
  return { owner: owner!, name: name! }
}

export const runAgentLoop = Effect.gen(function* () {
  const state = yield* AnomalyStateService
  const detection = yield* AnomalyDetectionService
  const github = yield* GitHubIssueService
  const db = yield* SqliteDrizzle

  // 1. Load all active GitHub integrations from DB
  const integrations = yield* db
    .select()
    .from(githubIntegrations)
    .where(eq(githubIntegrations.enabled, 1))
    .pipe(Effect.orDie)

  if (integrations.length === 0) {
    yield* Effect.logDebug("No active GitHub integrations, skipping cycle")
    return
  }

  yield* Effect.logInfo(`Processing ${integrations.length} active integration(s)`)

  // 2. For each integration (org), run detection
  yield* Effect.forEach(
    integrations,
    (integration) =>
      processOrg(integration, detection, state, github).pipe(
        Effect.catchAll((error) =>
          Effect.logError(
            `Error processing org ${integration.orgId}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
      ),
    { concurrency: 3 },
  )
})

const processOrg = (
  integration: typeof githubIntegrations.$inferSelect,
  detection: AnomalyDetectionService,
  state: AnomalyStateService,
  github: GitHubIssueService,
) =>
  Effect.gen(function* () {
    // Detect anomalies for this org
    const anomalies = yield* detection.detectForOrg(integration.orgId)

    if (anomalies.length === 0) {
      yield* Effect.logDebug(`No anomalies detected for org ${integration.orgId}`)
      return
    }

    yield* Effect.logInfo(
      `Detected ${anomalies.length} anomaly/anomalies for org ${integration.orgId}`,
    )

    // Deduplicate
    const newAnomalies = yield* state.filterNew(integration.orgId, anomalies)
    if (newAnomalies.length === 0) {
      yield* Effect.logDebug(
        `All ${anomalies.length} anomalies already within cooldown for org ${integration.orgId}`,
      )
      return
    }

    yield* Effect.logInfo(
      `${newAnomalies.length} new anomaly/anomalies for org ${integration.orgId}`,
    )

    // Parse selected repos
    let repos: RepoInfo[] = []
    try {
      repos = JSON.parse(integration.selectedRepos) as RepoInfo[]
    } catch {
      yield* Effect.logWarning(
        `Failed to parse selected repos for org ${integration.orgId}, skipping issue creation`,
      )
      return
    }

    // Parse default repo
    let defaultRepo: RepoInfo | null = null
    try {
      if (integration.defaultRepo) {
        defaultRepo = JSON.parse(integration.defaultRepo) as RepoInfo
      }
    } catch { /* empty */ }

    // Parse service-to-repo mappings
    let mappings: ServiceRepoMappingEntry[] = []
    try {
      mappings = JSON.parse(integration.serviceRepoMappings) as ServiceRepoMappingEntry[]
    } catch { /* empty */ }

    const serviceToRepo = new Map<string, { owner: string; name: string; fullName: string }>()
    for (const m of mappings) {
      serviceToRepo.set(m.serviceName, { ...parseRepoFullName(m.repoFullName), fullName: m.repoFullName })
    }

    // Check if we have any way to create issues
    if (repos.length === 0 && !defaultRepo && serviceToRepo.size === 0) {
      yield* Effect.logDebug(
        `No target repos configured for org ${integration.orgId}, recording anomalies without issues`,
      )
      for (const anomaly of newAnomalies) {
        yield* state.recordAnomaly(integration.orgId, anomaly, null, null, null)
      }
      return
    }

    function resolveTargetRepo(anomaly: { serviceName?: string; affectedServices: readonly string[] }): { owner: string; name: string; fullName: string } | undefined {
      if (anomaly.serviceName) {
        const mapped = serviceToRepo.get(anomaly.serviceName)
        if (mapped) return mapped
      }
      for (const svc of anomaly.affectedServices) {
        const mapped = serviceToRepo.get(svc)
        if (mapped) return mapped
      }
      if (defaultRepo) return { owner: defaultRepo.owner, name: defaultRepo.name, fullName: defaultRepo.fullName }
      if (repos[0]) return { owner: repos[0].owner, name: repos[0].name, fullName: repos[0].fullName }
      return undefined
    }

    // Get installation token
    const token = yield* github.getInstallationToken(integration.installationId)

    // Create issues (sequential to respect rate limits)
    yield* Effect.forEach(
      newAnomalies,
      (anomaly) =>
        Effect.gen(function* () {
          const targetRepo = resolveTargetRepo(anomaly)
          if (!targetRepo) {
            yield* Effect.logDebug(`No target repo for anomaly "${anomaly.title}", recording without issue`)
            yield* state.recordAnomaly(integration.orgId, anomaly, null, null, null)
            return
          }
          const issue = yield* github.createIssue(
            token,
            targetRepo.owner,
            targetRepo.name,
            anomaly,
          )
          yield* state.recordAnomaly(
            integration.orgId,
            anomaly,
            issue.number,
            issue.url,
            targetRepo.fullName,
          )
          yield* Effect.logInfo(
            `Created issue #${issue.number} in ${targetRepo.fullName}: ${anomaly.title}`,
          )
        }).pipe(
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              yield* Effect.logError(
                `Failed to create issue for anomaly "${anomaly.title}": ${error instanceof Error ? error.message : String(error)}`,
              )
              // Still record the anomaly to avoid re-filing
              yield* state
                .recordAnomaly(integration.orgId, anomaly, null, null, null)
                .pipe(Effect.catchAll(() => Effect.void))
            }),
          ),
        ),
      { concurrency: 1 },
    )
  })
