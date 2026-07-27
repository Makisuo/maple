import path from "node:path"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Command from "alchemy/Command"
import * as Output from "alchemy/Output"
import * as Effect from "effect/Effect"
import {
	CLOUDFLARE_WORKER_PLACEMENT,
	resolveWorkerName,
	type MapleDomains,
	type MapleStage,
} from "@maple/infra/cloudflare"

export interface CreateLandingWorkerOptions {
	stage: MapleStage
	domains: MapleDomains
	logsDestination?: Cloudflare.Workers.ObservabilityDestination
	tracesDestination?: Cloudflare.Workers.ObservabilityDestination
}

export const createLandingWorker = ({
	stage,
	domains,
	logsDestination,
	tracesDestination,
}: CreateLandingWorkerOptions) =>
	Effect.gen(function* () {
		// Astro static build (memoized on the app's source files, skipped on destroy).
		const build = yield* Command.Build("landing-build", {
			command: "bun run build",
			cwd: import.meta.dirname,
			outdir: "dist",
		})

		const worker = yield* Cloudflare.Worker<{}, Cloudflare.AssetsWithHash>("landing", {
			name: resolveWorkerName("landing", stage),
			main: path.join(import.meta.dirname, "src", "worker.ts"),
			// The `assets` prop auto-adds the ASSETS binding `src/worker.ts` reads.
			assets: { directory: build.outdir, hash: Output.map(build.hash, (h) => h.output ?? "") },
			compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
			placement: CLOUDFLARE_WORKER_PLACEMENT,
			observability: {
				enabled: true,
				logs: {
					enabled: true,
					invocationLogs: true,
					destinations: [logsDestination?.slug ?? "maple"],
				},
				traces: {
					enabled: true,
					destinations: [tracesDestination?.slug ?? "maple"],
				},
			},
			url: true,
			domain: domains.landing,
		})

		return worker
	})
