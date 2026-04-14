import alchemy from "alchemy"
import { D1Database, Worker } from "alchemy/cloudflare"
import { CloudflareStateStore } from "alchemy/state"

const app = await alchemy("maple-api", {
  ...(process.env.ALCHEMY_STATE_TOKEN
    ? { stateStore: (scope) => new CloudflareStateStore(scope) }
    : {}),
})

const workerName =
  app.stage === "prd"
    ? "maple-api"
    : app.stage === "stg"
      ? "maple-api-stg"
      : `maple-api-${app.stage}`

const databaseName =
  app.stage === "prd"
    ? "maple-api"
    : app.stage === "stg"
      ? "maple-api-stg"
      : `maple-api-${app.stage}`

const domains =
  app.stage === "prd"
    ? [{ domainName: "api.maple.dev", adopt: true }]
    : app.stage === "stg"
      ? [{ domainName: "api-staging.maple.dev", adopt: true }]
      : undefined

export const mapleDb = await D1Database("maple-db", {
  name: databaseName,
  adopt: true,
  migrationsDir: "../../packages/db/drizzle",
})

const requireEnv = (key: string) => {
  const value = process.env[key]?.trim()
  if (!value) {
    throw new Error(`Missing required deployment env: ${key}`)
  }
  return value
}

const optionalEnv = (key: string) => process.env[key]?.trim() || undefined

const optionalSecret = (key: string) => {
  const value = optionalEnv(key)
  return value !== undefined ? { [key]: alchemy.secret(value) } : {}
}

const optionalString = (key: string) => {
  const value = optionalEnv(key)
  return value !== undefined ? { [key]: value } : {}
}

export const apiWorker = await Worker("maple-api", {
  name: workerName,
  entrypoint: "./src/worker.ts",
  compatibility: "node",
  url: true,
  adopt: true,
  domains,
  bindings: {
    MAPLE_DB: mapleDb,
    TINYBIRD_HOST: requireEnv("TINYBIRD_HOST"),
    TINYBIRD_TOKEN: alchemy.secret(requireEnv("TINYBIRD_TOKEN")),
    MAPLE_AUTH_MODE: optionalEnv("MAPLE_AUTH_MODE") ?? "self_hosted",
    MAPLE_DEFAULT_ORG_ID: optionalEnv("MAPLE_DEFAULT_ORG_ID") ?? "default",
    MAPLE_INGEST_KEY_ENCRYPTION_KEY: alchemy.secret(
      requireEnv("MAPLE_INGEST_KEY_ENCRYPTION_KEY"),
    ),
    MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: alchemy.secret(
      requireEnv("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY"),
    ),
    MAPLE_INGEST_PUBLIC_URL:
      optionalEnv("MAPLE_INGEST_PUBLIC_URL") ?? "https://ingest.maple.dev",
    MAPLE_APP_BASE_URL:
      optionalEnv("MAPLE_APP_BASE_URL") ?? "https://app.maple.dev",
    RESEND_FROM_EMAIL:
      optionalEnv("RESEND_FROM_EMAIL") ?? "Maple <notifications@maple.dev>",
    ...optionalSecret("MAPLE_ROOT_PASSWORD"),
    ...optionalSecret("CLERK_SECRET_KEY"),
    ...optionalString("CLERK_PUBLISHABLE_KEY"),
    ...optionalSecret("CLERK_JWT_KEY"),
    ...optionalString("MAPLE_ORG_ID_OVERRIDE"),
    ...optionalSecret("AUTUMN_SECRET_KEY"),
    ...optionalSecret("SD_INTERNAL_TOKEN"),
    ...optionalSecret("INTERNAL_SERVICE_TOKEN"),
    ...optionalSecret("RESEND_API_KEY"),
  },
})

console.log({
  stage: app.stage,
  apiUrl: domains?.[0]?.domainName
    ? `https://${domains[0].domainName}`
    : apiWorker.url,
  databaseName,
})

await app.finalize()
