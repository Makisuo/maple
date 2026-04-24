import path from "node:path"
import alchemy from "alchemy"
import { D1Database, Worker, Workflow } from "alchemy/cloudflare"
import type { TinybirdSyncWorkflowPayload } from "./src/workflows/TinybirdSyncWorkflow"
import type {
  MapleDomains,
  MapleStage,
} from "@maple/infra/cloudflare"
import {
  formatMapleStage,
  resolveD1Name,
  resolveWorkerName,
} from "@maple/infra/cloudflare"

const requireEnv = (key: string): string => {
  const value = process.env[key]?.trim()
  if (!value) {
    throw new Error(`Missing required deployment env: ${key}`)
  }
  return value
}

const optionalPlain = (
  key: string,
  fallback?: string,
): Record<string, string> => {
  const value = process.env[key]?.trim() || fallback
  return value ? { [key]: value } : {}
}

const optionalSecret = (
  key: string,
): Record<string, ReturnType<typeof alchemy.secret>> => {
  const value = process.env[key]?.trim()
  return value ? { [key]: alchemy.secret(value) } : {}
}

export interface CreateMapleApiOptions {
  stage: MapleStage
  domains: MapleDomains
}

export const createMapleApi = async ({ stage, domains }: CreateMapleApiOptions) => {
  const mapleDb = await D1Database("MAPLE_DB", {
    name: resolveD1Name(stage),
    adopt: true,
    migrationsDir: path.resolve(
      import.meta.dirname,
      "../../packages/db/drizzle",
    ),
    migrationsTable: "drizzle_migrations",
  })

  const tinybirdSyncWorkflow = Workflow<TinybirdSyncWorkflowPayload>(
    "tinybird-sync-workflow",
    {
      workflowName: resolveWorkerName("tinybird-sync", stage),
      className: "TinybirdSyncWorkflow",
    },
  )

  const worker = await Worker("api", {
    name: resolveWorkerName("api", stage),
    cwd: import.meta.dirname,
    entrypoint: path.join(import.meta.dirname, "src", "worker.ts"),
    compatibility: "node",
    compatibilityDate: "2026-04-08",
    url: true,
    adopt: true,
    routes: domains.api
      ? [{ pattern: `${domains.api}/*`, adopt: true }]
      : undefined,
    bindings: {
      MAPLE_DB: mapleDb,
      TINYBIRD_SYNC_WORKFLOW: tinybirdSyncWorkflow,
      TINYBIRD_HOST: requireEnv("TINYBIRD_HOST"),
      TINYBIRD_TOKEN: alchemy.secret(requireEnv("TINYBIRD_TOKEN")),
      MAPLE_AUTH_MODE: process.env.MAPLE_AUTH_MODE?.trim() || "self_hosted",
      MAPLE_DEFAULT_ORG_ID: process.env.MAPLE_DEFAULT_ORG_ID?.trim() || "default",
      MAPLE_INGEST_KEY_ENCRYPTION_KEY: alchemy.secret(
        requireEnv("MAPLE_INGEST_KEY_ENCRYPTION_KEY"),
      ),
      MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: alchemy.secret(
        requireEnv("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY"),
      ),
      MAPLE_INGEST_PUBLIC_URL:
        process.env.MAPLE_INGEST_PUBLIC_URL?.trim() || "https://ingest.maple.dev",
      MAPLE_APP_BASE_URL:
        process.env.MAPLE_APP_BASE_URL?.trim() || "https://app.maple.dev",
      RESEND_FROM_EMAIL:
        process.env.RESEND_FROM_EMAIL?.trim() ||
        "Maple <notifications@maple.dev>",
      // Bucket-cache knobs: on by default in deployed stages. Override via
      // deploy-time env (e.g. `QE_BUCKET_CACHE_ENABLED=false`) if needed.
      QE_BUCKET_CACHE_ENABLED:
        process.env.QE_BUCKET_CACHE_ENABLED?.trim() || "true",
      QE_BUCKET_CACHE_TTL_SECONDS:
        process.env.QE_BUCKET_CACHE_TTL_SECONDS?.trim() || "86400",
      QE_BUCKET_CACHE_FLUX_SECONDS:
        process.env.QE_BUCKET_CACHE_FLUX_SECONDS?.trim() || "60",
      ...optionalPlain("OTEL_BASE_URL"),
      ...optionalPlain("OTEL_ENVIRONMENT", formatMapleStage(stage)),
      ...optionalPlain("COMMIT_SHA"),
      ...optionalSecret("MAPLE_OTEL_INGEST_KEY"),
      ...optionalSecret("MAPLE_ROOT_PASSWORD"),
      ...optionalSecret("CLERK_SECRET_KEY"),
      ...optionalPlain("CLERK_PUBLISHABLE_KEY"),
      ...optionalSecret("CLERK_JWT_KEY"),
      ...optionalSecret("AUTUMN_SECRET_KEY"),
      ...optionalSecret("SD_INTERNAL_TOKEN"),
      ...optionalSecret("INTERNAL_SERVICE_TOKEN"),
      ...optionalSecret("RESEND_API_KEY"),
      ...optionalPlain("MAPLE_SELF_MANAGED_COLLECTOR_RELOAD_URL"),
      ...optionalSecret("MAPLE_SELF_MANAGED_COLLECTOR_RELOAD_TOKEN"),
    },
  })

  return { worker, db: mapleDb }
}
