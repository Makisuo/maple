import { spawnSync } from "node:child_process"
import path from "node:path"
import { Assets, Worker } from "alchemy/cloudflare"
import type {
  MapleDomains,
  MapleStage,
} from "@maple/infra/cloudflare"
import { resolveWorkerName } from "@maple/infra/cloudflare"

export interface CreateLandingWorkerOptions {
  stage: MapleStage
  domains: MapleDomains
}

export const createLandingWorker = async ({
  stage,
  domains,
}: CreateLandingWorkerOptions) => {
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

  const worker = await Worker("landing", {
    name: resolveWorkerName("landing", stage),
    cwd: import.meta.dirname,
    entrypoint: path.join(import.meta.dirname, "src", "worker.ts"),
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

  return worker
}
