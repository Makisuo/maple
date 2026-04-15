/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "maple",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "cloudflare",
    }
  },
  async run() {
    const stage = $app.stage

    const webDomain =
      stage === "production"
        ? "app.maple.dev"
        : stage === "staging"
          ? "staging.maple.dev"
          : undefined

    const environment: Record<string, string> =
      stage === "production"
        ? {
            VITE_API_BASE_URL: "https://api.maple.dev",
            VITE_INGEST_URL: "https://ingest.maple.dev",
            VITE_CHAT_AGENT_URL: "https://chat.maple.dev",
            VITE_MAPLE_AUTH_MODE: process.env.MAPLE_AUTH_MODE ?? "clerk",
            VITE_CLERK_PUBLISHABLE_KEY:
              process.env.CLERK_PUBLISHABLE_KEY ?? "",
          }
        : stage === "staging"
          ? {
              VITE_API_BASE_URL: "https://api-stg.maple.dev",
              VITE_INGEST_URL: "https://ingest-stg.maple.dev",
              VITE_CHAT_AGENT_URL: "https://chat-staging.maple.dev",
              VITE_MAPLE_AUTH_MODE: process.env.MAPLE_AUTH_MODE ?? "clerk",
              VITE_CLERK_PUBLISHABLE_KEY:
                process.env.CLERK_PUBLISHABLE_KEY ?? "",
            }
          : {}

    const web = new sst.cloudflare.Worker("Web", {
      handler: "apps/web/src/worker.ts",
      url: true,
      domain: webDomain,
      assets: { directory: "apps/web/dist" },
      environment,
    })

    const landingDomain =
      stage === "production"
        ? "maple.dev"
        : stage === "staging"
          ? "staging-landing.maple.dev"
          : undefined

    const landing = new sst.cloudflare.Worker("Landing", {
      handler: "apps/landing/src/worker.ts",
      url: true,
      domain: landingDomain,
      assets: { directory: "apps/landing/dist" },
    })

    const apiDomain =
      stage === "production"
        ? "api.maple.dev"
        : stage === "staging"
          ? "api-staging.maple.dev"
          : undefined

    const mapleDbName =
      stage === "production"
        ? "maple-api"
        : stage === "staging"
          ? "maple-api-stg"
          : `maple-api-${stage}`

    const mapleDb = new sst.cloudflare.D1("MAPLE_DB", {
      transform: {
        database: {
          name: mapleDbName,
        },
      },
    })

    const requireEnv = (key: string) => {
      const value = process.env[key]?.trim()
      if (!value) {
        throw new Error(`Missing required deployment env: ${key}`)
      }
      return value
    }

    const optEnv = (key: string) => process.env[key]?.trim() || undefined

    const withOptional = (
      key: string,
    ): Record<string, string> => {
      const value = optEnv(key)
      return value !== undefined ? { [key]: value } : {}
    }

    const api = new sst.cloudflare.Worker("Api", {
      handler: "apps/api/src/worker.ts",
      url: true,
      domain: apiDomain,
      link: [mapleDb],
      environment: {
        TINYBIRD_HOST: requireEnv("TINYBIRD_HOST"),
        TINYBIRD_TOKEN: requireEnv("TINYBIRD_TOKEN"),
        MAPLE_AUTH_MODE: optEnv("MAPLE_AUTH_MODE") ?? "self_hosted",
        MAPLE_DEFAULT_ORG_ID: optEnv("MAPLE_DEFAULT_ORG_ID") ?? "default",
        MAPLE_INGEST_KEY_ENCRYPTION_KEY: requireEnv(
          "MAPLE_INGEST_KEY_ENCRYPTION_KEY",
        ),
        MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: requireEnv(
          "MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY",
        ),
        MAPLE_INGEST_PUBLIC_URL:
          optEnv("MAPLE_INGEST_PUBLIC_URL") ?? "https://ingest.maple.dev",
        MAPLE_APP_BASE_URL:
          optEnv("MAPLE_APP_BASE_URL") ?? "https://app.maple.dev",
        RESEND_FROM_EMAIL:
          optEnv("RESEND_FROM_EMAIL") ?? "Maple <notifications@maple.dev>",
        ...withOptional("MAPLE_ROOT_PASSWORD"),
        ...withOptional("CLERK_SECRET_KEY"),
        ...withOptional("CLERK_PUBLISHABLE_KEY"),
        ...withOptional("CLERK_JWT_KEY"),
        ...withOptional("MAPLE_ORG_ID_OVERRIDE"),
        ...withOptional("AUTUMN_SECRET_KEY"),
        ...withOptional("SD_INTERNAL_TOKEN"),
        ...withOptional("INTERNAL_SERVICE_TOKEN"),
        ...withOptional("RESEND_API_KEY"),
      },
      transform: {
        worker: {
          compatibilityDate: "2026-04-08",
          compatibilityFlags: ["nodejs_compat"],
        },
      },
    })

    return {
      web: web.url,
      webDomain,
      landing: landing.url,
      landingDomain,
      api: api.url,
      apiDomain,
    }
  },
})
