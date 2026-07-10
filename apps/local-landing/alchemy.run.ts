import { spawnSync } from "node:child_process"
import path from "node:path"
import { Assets, Worker } from "alchemy/cloudflare"
import {
	CLOUDFLARE_WORKER_PLACEMENT,
	resolveWorkerName,
	type MapleDomains,
	type MapleStage,
} from "@maple/infra/cloudflare"

export interface CreateLocalLandingWorkerOptions {
	stage: MapleStage
	domains: MapleDomains
}

export const createLocalLandingWorker = async ({ stage, domains }: CreateLocalLandingWorkerOptions) => {
	const isDestroy = process.argv.some((arg) => arg === "destroy")
	if (!isDestroy) {
		const build = spawnSync("bun", ["run", "build"], {
			stdio: "inherit",
			cwd: import.meta.dirname,
			env: process.env,
		})
		if (build.status !== 0) {
			throw new Error(`local-landing build failed with exit code ${build.status ?? "unknown"}`)
		}
	}

	const worker = await Worker("local-landing", {
		name: resolveWorkerName("local-landing", stage),
		cwd: import.meta.dirname,
		entrypoint: path.join(import.meta.dirname, "src", "worker.ts"),
		compatibility: "node",
		placement: CLOUDFLARE_WORKER_PLACEMENT,
		url: true,
		adopt: true,
		domains: domains.localLanding ? [{ domainName: domains.localLanding, adopt: true }] : undefined,
		bindings: {
			ASSETS: await Assets({ path: path.join(import.meta.dirname, "dist") }),
		},
	})

	return worker
}
