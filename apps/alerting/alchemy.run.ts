import path from "node:path"
import alchemy from "alchemy"
import { Worker, type D1Database } from "alchemy/cloudflare"
import type {
  MapleDomains,
  MapleStage,
} from "@maple/infra/cloudflare"
import { resolveWorkerName } from "@maple/infra/cloudflare"

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

export interface CreateAlertingWorkerOptions {
  stage: MapleStage
  domains: MapleDomains
  mapleDb: D1Database
}

export const createAlertingWorker = async ({
  stage,
  mapleDb,
}: CreateAlertingWorkerOptions) => {
  const worker = await Worker("alerting", {
    name: resolveWorkerName("alerting", stage),
    cwd: import.meta.dirname,
    entrypoint: path.join(import.meta.dirname, "src", "worker.ts"),
    compatibility: "node",
    compatibilityDate: "2026-04-08",
    adopt: true,
    crons: ["* * * * *", "*/15 * * * *"],
    bindings: {
      MAPLE_DB: mapleDb,
      TINYBIRD_HOST: requireEnv("TINYBIRD_HOST"),
      TINYBIRD_TOKEN: alchemy.secret(requireEnv("TINYBIRD_TOKEN")),
      MAPLE_AUTH_MODE: process.env.MAPLE_AUTH_MODE?.trim() || "self_hosted",
      MAPLE_DEFAULT_ORG_ID:
        process.env.MAPLE_DEFAULT_ORG_ID?.trim() || "default",
      MAPLE_INGEST_KEY_ENCRYPTION_KEY: alchemy.secret(
        requireEnv("MAPLE_INGEST_KEY_ENCRYPTION_KEY"),
      ),
      MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: alchemy.secret(
        requireEnv("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY"),
      ),
      MAPLE_INGEST_PUBLIC_URL:
        process.env.MAPLE_INGEST_PUBLIC_URL?.trim() ||
        "https://ingest.maple.dev",
      MAPLE_APP_BASE_URL:
        process.env.MAPLE_APP_BASE_URL?.trim() || "https://app.maple.dev",
      RESEND_FROM_EMAIL:
        process.env.RESEND_FROM_EMAIL?.trim() ||
        "Maple <notifications@maple.dev>",
      ...optionalSecret("MAPLE_ROOT_PASSWORD"),
      ...optionalSecret("CLERK_SECRET_KEY"),
      ...optionalPlain("CLERK_PUBLISHABLE_KEY"),
      ...optionalSecret("CLERK_JWT_KEY"),
      ...optionalPlain("MAPLE_ORG_ID_OVERRIDE"),
      ...optionalSecret("AUTUMN_SECRET_KEY"),
      ...optionalSecret("SD_INTERNAL_TOKEN"),
      ...optionalSecret("INTERNAL_SERVICE_TOKEN"),
      ...optionalSecret("RESEND_API_KEY"),
    },
  })

  return worker
}
