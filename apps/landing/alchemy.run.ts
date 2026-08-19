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
	/** Baked into the client bundle so the site reports to the right ingest. */
	ingestUrl: string
	logsDestination?: Cloudflare.Workers.ObservabilityDestination
	tracesDestination?: Cloudflare.Workers.ObservabilityDestination
}

export const createLandingWorker = ({
	stage,
	domains,
	ingestUrl,
	logsDestination,
	tracesDestination,
}: CreateLandingWorkerOptions) =>
	Effect.gen(function* () {
		// Astro static build (memoized on the app's source files, skipped on destroy).
		const build = yield* Command.Build("landing-build", {
			command: "bun run build",
			cwd: import.meta.dirname,
			outdir: "dist",
			// Astro inlines PUBLIC_* at build time, so these belong to the build memo
			// hash — a key or endpoint change has to produce a new bundle. Same
			// ingest key the web app uses, so both surfaces land in one org and a
			// visitor's marketing and product sessions sit side by side.
			env: {
				PUBLIC_MAPLE_INGEST_KEY: process.env.MAPLE_OTEL_PUBLIC_INGEST_KEY ?? "",
				PUBLIC_INGEST_URL: ingestUrl,
			},
		})

		const worker = yield* Cloudflare.Worker<{}, Cloudflare.AssetsWithHash>("landing", {
			name: resolveWorkerName("landing", stage),
			main: path.join(import.meta.dirname, "src", "worker.ts"),
			// The `assets` prop auto-adds the ASSETS binding `src/worker.ts` reads.
			assets: {
				directory: build.outdir,
				hash: Output.map(build.hash, (h) => h.output ?? ""),
				// Workers Assets serves a matching file *before* invoking the Worker,
				// so without this `src/worker.ts` never sees a request for a real page
				// and the `Accept: text/markdown` negotiation is dead code. Scoped to
				// extensionless paths — the ones with a `.md` twin. Anything with a
				// dot (hashed `/_astro/*`, images, the `.md` and `.txt` files
				// themselves) still comes straight off the asset layer with no Worker
				// invocation.
				runWorkerFirst: ["/*", "!/_astro/*", "!/*.*"],
			},
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
					// Off: CF marks every non-2xx `fetch` span Error, so bot 404s
					// (/wp-admin, /.git/config) flooded error issues with "Unknown Error".
					enabled: false,
					destinations: [tracesDestination?.slug ?? "maple"],
				},
			},
			workersDev: true,
			domain: domains.landing,
		})

		return worker
	})
