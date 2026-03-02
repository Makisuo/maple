import { createClient, type Client } from "@libsql/client"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { DetectedAnomaly } from "./types"
import { getConfig } from "./config"

let _client: Client | null = null

function getClient(): Client {
  if (_client) return _client
  const config = getConfig()

  if (config.MAPLE_DB_URL) {
    _client = createClient({
      url: config.MAPLE_DB_URL,
      authToken: config.MAPLE_DB_AUTH_TOKEN || undefined,
    })
  } else {
    // Default to the Maple API's local database
    const defaultPath = resolve(import.meta.dirname, "../../../../../apps/api/.data/maple.db")
    _client = createClient({ url: pathToFileURL(defaultPath).href })
  }

  return _client
}

export async function ensureTable(): Promise<void> {
  const client = getClient()
  // The detected_anomalies table is created by the Maple API migrations.
  // Only create it if it doesn't already exist (e.g. fresh local dev).
  await client.execute(`
    CREATE TABLE IF NOT EXISTS detected_anomalies (
      id TEXT PRIMARY KEY NOT NULL,
      org_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      details_json TEXT NOT NULL,
      github_issue_number INTEGER,
      github_issue_url TEXT,
      github_repo TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      detected_at INTEGER NOT NULL,
      cooldown_until INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  await client.execute(`
    CREATE INDEX IF NOT EXISTS anomalies_org_fp_cooldown_idx
    ON detected_anomalies (org_id, fingerprint, cooldown_until)
  `)
  await client.execute(`
    CREATE INDEX IF NOT EXISTS anomalies_org_status_idx
    ON detected_anomalies (org_id, status)
  `)
}

export async function filterNewAnomalies(
  orgId: string,
  anomalies: DetectedAnomaly[],
): Promise<DetectedAnomaly[]> {
  if (anomalies.length === 0) return []

  const client = getClient()
  const now = Date.now()
  const newAnomalies: DetectedAnomaly[] = []

  for (const anomaly of anomalies) {
    const result = await client.execute({
      sql: `SELECT 1 FROM detected_anomalies
            WHERE org_id = ? AND fingerprint = ? AND cooldown_until > ?
            LIMIT 1`,
      args: [orgId, anomaly.fingerprint, now],
    })

    if (result.rows.length === 0) {
      newAnomalies.push(anomaly)
    }
  }

  return newAnomalies
}

export async function recordAnomaly(
  orgId: string,
  anomaly: DetectedAnomaly,
  issueNumber: number | null,
  issueUrl: string | null,
  repo: string | null,
): Promise<void> {
  const client = getClient()
  const config = getConfig()
  const now = Date.now()
  const cooldownMs = config.AGENT_COOLDOWN_HOURS * 60 * 60 * 1000

  await client.execute({
    sql: `INSERT INTO detected_anomalies
          (id, org_id, fingerprint, kind, severity, title, details_json,
           github_issue_number, github_issue_url, github_repo, status,
           detected_at, cooldown_until, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    args: [
      randomUUID(),
      orgId,
      anomaly.fingerprint,
      anomaly.kind,
      anomaly.severity,
      anomaly.title,
      JSON.stringify({
        description: anomaly.description,
        serviceName: anomaly.serviceName,
        affectedServices: anomaly.affectedServices,
        currentValue: anomaly.currentValue,
        baselineValue: anomaly.baselineValue,
        thresholdValue: anomaly.thresholdValue,
        sampleTraceIds: anomaly.sampleTraceIds,
      }),
      issueNumber,
      issueUrl,
      repo,
      new Date(anomaly.detectedAt).getTime(),
      now + cooldownMs,
      now,
    ],
  })
}

export async function getOrgConfigs(): Promise<
  Array<{
    orgId: string
    installationId: number
    selectedRepos: string
    defaultRepo: string | null
    serviceRepoMappings: string
  }>
> {
  const client = getClient()

  try {
    const result = await client.execute(
      `SELECT org_id, installation_id, selected_repos, default_repo, service_repo_mappings
       FROM github_integrations
       WHERE enabled = 1`,
    )

    return result.rows.map((row) => ({
      orgId: row.org_id as string,
      installationId: row.installation_id as number,
      selectedRepos: row.selected_repos as string,
      defaultRepo: row.default_repo as string | null,
      serviceRepoMappings: (row.service_repo_mappings as string) || "[]",
    }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("no such table")) {
      console.warn("[state] github_integrations table not found — ensure MAPLE_DB_URL points to the Maple API database")
      return []
    }
    throw err
  }
}
