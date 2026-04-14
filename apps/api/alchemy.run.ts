import { Stack } from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"

const requireEnv = (key: string) => {
  const value = process.env[key]?.trim()
  if (!value) {
    throw new Error(`Missing required deployment env: ${key}`)
  }
  return value
}

const optionalEnv = (key: string) => process.env[key]?.trim() || undefined

export const MapleDb = Cloudflare.D1Database("MapleDb")

export const ApiWorker = Cloudflare.Worker("ApiWorker", {
  main: "./src/worker.ts",
  url: true,
  compatibility: {
    date: "2026-04-08",
    flags: ["nodejs_compat"],
  },
  bindings: {
    MAPLE_DB: MapleDb,
  },
  env: {
    TINYBIRD_HOST: requireEnv("TINYBIRD_HOST"),
    TINYBIRD_TOKEN: requireEnv("TINYBIRD_TOKEN"),
    MAPLE_AUTH_MODE: optionalEnv("MAPLE_AUTH_MODE") ?? "self_hosted",
    MAPLE_ROOT_PASSWORD: optionalEnv("MAPLE_ROOT_PASSWORD"),
    MAPLE_DEFAULT_ORG_ID: optionalEnv("MAPLE_DEFAULT_ORG_ID") ?? "default",
    MAPLE_INGEST_KEY_ENCRYPTION_KEY: requireEnv(
      "MAPLE_INGEST_KEY_ENCRYPTION_KEY",
    ),
    MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: requireEnv(
      "MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY",
    ),
    MAPLE_INGEST_PUBLIC_URL:
      optionalEnv("MAPLE_INGEST_PUBLIC_URL") ?? "https://ingest.maple.dev",
    MAPLE_APP_BASE_URL:
      optionalEnv("MAPLE_APP_BASE_URL") ?? "https://app.maple.dev",
    CLERK_SECRET_KEY: optionalEnv("CLERK_SECRET_KEY"),
    CLERK_PUBLISHABLE_KEY: optionalEnv("CLERK_PUBLISHABLE_KEY"),
    CLERK_JWT_KEY: optionalEnv("CLERK_JWT_KEY"),
    MAPLE_ORG_ID_OVERRIDE: optionalEnv("MAPLE_ORG_ID_OVERRIDE"),
    AUTUMN_SECRET_KEY: optionalEnv("AUTUMN_SECRET_KEY"),
    SD_INTERNAL_TOKEN: optionalEnv("SD_INTERNAL_TOKEN"),
    INTERNAL_SERVICE_TOKEN: optionalEnv("INTERNAL_SERVICE_TOKEN"),
    RESEND_API_KEY: optionalEnv("RESEND_API_KEY"),
    RESEND_FROM_EMAIL:
      optionalEnv("RESEND_FROM_EMAIL") ?? "Maple <notifications@maple.dev>",
    MAPLE_DB_URL: optionalEnv("MAPLE_DB_URL"),
    MAPLE_DB_AUTH_TOKEN: optionalEnv("MAPLE_DB_AUTH_TOKEN"),
  },
})

export type ApiWorkerEnv = Cloudflare.InferEnv<typeof ApiWorker>

export default Stack(
  "MapleApi",
  { providers: Cloudflare.providers() },
  Effect.gen(function* () {
    const worker = yield* ApiWorker
    const db = yield* MapleDb
    return {
      url: worker.url,
      databaseId: db.databaseId,
      workerName: worker.workerName,
    }
  }),
)
