import path from "node:path"
import alchemy from "alchemy"
import { D1Database, Worker } from "alchemy/cloudflare"
import { CloudflareStateStore } from "alchemy/state"
import {
  parseMapleStage,
  resolveD1Name,
  resolveMapleDomains,
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

const optionalSecret = (key: string): Record<string, ReturnType<typeof alchemy.secret>> => {
  const value = process.env[key]?.trim()
  return value ? { [key]: alchemy.secret(value) } : {}
}

const app = await alchemy("maple-api", {
  password: requireEnv("ALCHEMY_PASSWORD"),
  ...(process.env.ALCHEMY_STATE_TOKEN
    ? { stateStore: (scope) => new CloudflareStateStore(scope) }
    : {}),
})

const stage = parseMapleStage(app.stage)
const domains = resolveMapleDomains(stage)

const mapleDb = await D1Database("MAPLE_DB", {
  name: resolveD1Name(stage),
  adopt: true,
  migrationsDir: path.resolve(
    import.meta.dirname,
    "../../packages/db/drizzle",
  ),
  migrationsTable: "drizzle_migrations",
})

export const api = await Worker("api", {
  name: resolveWorkerName("api", stage),
  entrypoint: "src/worker.ts",
  compatibility: "node",
  compatibilityDate: "2026-04-08",
  url: true,
  adopt: true,
  dev: { port: 3472 },
  domains: domains.api ? [{ domainName: domains.api, adopt: true }] : undefined,
  bindings: {
    MAPLE_DB: mapleDb,
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

console.log({
  stage: app.stage,
  apiUrl: domains.api ? `https://${domains.api}` : api.url,
  d1: resolveD1Name(stage),
})

await app.finalize()
