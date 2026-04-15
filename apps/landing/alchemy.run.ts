import alchemy from "alchemy"
import { Assets, Worker } from "alchemy/cloudflare"
import { CloudflareStateStore } from "alchemy/state"
import { spawnSync } from "node:child_process"
import path from "node:path"
import {
  parseMapleStage,
  resolveMapleDomains,
  resolveWorkerName,
} from "@maple/infra/cloudflare"

const app = await alchemy("maple-landing", {
  ...(process.env.ALCHEMY_STATE_TOKEN
    ? { stateStore: (scope) => new CloudflareStateStore(scope) }
    : {}),
})

const stage = parseMapleStage(app.stage)
const domains = resolveMapleDomains(stage)

const isDestroy = process.argv.some((arg) => arg === "destroy")
if (!isDestroy) {
  const build = spawnSync("bun", ["run", "build"], {
    stdio: "inherit",
    cwd: import.meta.dirname,
    env: process.env,
  })
  if (build.status !== 0) {
    throw new Error(
      `landing build failed with exit code ${build.status ?? "unknown"}`,
    )
  }
}

export const landing = await Worker("landing", {
  name: resolveWorkerName("landing", stage),
  entrypoint: "src/worker.ts",
  compatibility: "node",
  url: true,
  adopt: true,
  domains: domains.landing
    ? [{ domainName: domains.landing, adopt: true }]
    : undefined,
  bindings: {
    ASSETS: await Assets({ path: path.join(import.meta.dirname, "dist") }),
  },
})

console.log({
  stage: app.stage,
  landingUrl: domains.landing ? `https://${domains.landing}` : landing.url,
})

await app.finalize()
