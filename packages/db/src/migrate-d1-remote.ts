import {
  applyD1Migrations,
  type ApplyD1MigrationsResult,
} from "./migrate-d1.ts"

export interface MigrateD1RemoteOptions {
  readonly stage: string
  readonly migrationsDir: string
  readonly accountId?: string
  readonly apiToken?: string
  readonly databaseName?: string
}

const PRODUCTION_DB_NAME = "maple-api"
const STAGING_DB_NAME = "maple-api-stg"
const DB_NAME_PREFIX = "maple-api-"

export const stageToD1Name = (stage: string): string => {
  const normalized = stage.trim().toLowerCase()
  if (normalized === "prd" || normalized === "production") {
    return PRODUCTION_DB_NAME
  }
  if (normalized === "stg" || normalized === "staging") {
    return STAGING_DB_NAME
  }
  return `${DB_NAME_PREFIX}${normalized}`
}

interface CloudflareListD1Response {
  readonly success: boolean
  readonly errors?: ReadonlyArray<{ code?: number; message?: string }>
  readonly result?: ReadonlyArray<{ readonly uuid: string; readonly name: string }>
}

export const lookupD1DatabaseId = async (opts: {
  readonly accountId: string
  readonly apiToken: string
  readonly databaseName: string
}): Promise<string> => {
  const url = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/d1/database?name=${encodeURIComponent(opts.databaseName)}`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${opts.apiToken}` },
  })
  const json = (await response.json()) as CloudflareListD1Response

  if (!response.ok || !json.success) {
    const detail = (json.errors ?? [])
      .map((e) => `${e.code ?? "?"}: ${e.message ?? "unknown"}`)
      .join("; ")
    throw new Error(
      `Cloudflare list-D1 failed (HTTP ${response.status}): ${detail || "no error detail"}`,
    )
  }

  const match = (json.result ?? []).find((d) => d.name === opts.databaseName)
  if (!match) {
    throw new Error(
      `No D1 database named "${opts.databaseName}" in Cloudflare account ${opts.accountId}`,
    )
  }
  return match.uuid
}

export const migrateD1Remote = async (
  opts: MigrateD1RemoteOptions,
): Promise<ApplyD1MigrationsResult> => {
  const accountId =
    opts.accountId ?? process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID?.trim()
  const apiToken = opts.apiToken ?? process.env.CLOUDFLARE_API_TOKEN?.trim()

  if (!accountId) {
    throw new Error(
      "CLOUDFLARE_DEFAULT_ACCOUNT_ID is required for remote D1 migrations",
    )
  }
  if (!apiToken) {
    throw new Error("CLOUDFLARE_API_TOKEN is required for remote D1 migrations")
  }

  const databaseName = opts.databaseName ?? stageToD1Name(opts.stage)
  const databaseId = await lookupD1DatabaseId({
    accountId,
    apiToken,
    databaseName,
  })

  return applyD1Migrations({
    target: { kind: "remote", accountId, databaseId, apiToken },
    migrationsDir: opts.migrationsDir,
  })
}
