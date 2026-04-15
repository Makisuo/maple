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

    const domain =
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
      domain,
      assets: { directory: "apps/web/dist" },
      environment,
    })

    return {
      web: web.url,
      webDomain: domain,
    }
  },
})
