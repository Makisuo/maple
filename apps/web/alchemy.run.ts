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

export interface CreateMapleWebOptions {
	stage: MapleStage
	domains: MapleDomains
	apiUrl: string
	ingestUrl: string
	flueChatUrl: string
	electricSyncUrl: string
}

// The web dashboard is a Vite SPA: `vite build` emits a flat `dist/` and
// `src/worker.ts` is a tiny assets-fallback worker (unknown routes → SPA
// shell). The build runs through `Command.Build` so the VITE_* env is part of
// the memo hash — a stage's URLs changing re-runs the build even when no
// source file changed. vite.config.ts turns these process-env VITE_* values
// into `define` overrides that win over `.env*` files.
export const createMapleWeb = ({
	stage,
	domains,
	apiUrl,
	ingestUrl,
	flueChatUrl,
	electricSyncUrl,
}: CreateMapleWebOptions) =>
	Effect.gen(function* () {
		const build = yield* Command.Build("web-build", {
			command: "bun run build",
			cwd: import.meta.dirname,
			outdir: "dist",
			env: {
				VITE_API_BASE_URL: apiUrl,
				VITE_INGEST_URL: ingestUrl,
				VITE_FLUE_CHAT_URL: flueChatUrl,
				VITE_ELECTRIC_SYNC_URL: electricSyncUrl,
				VITE_MAPLE_AUTH_MODE:
					process.env.VITE_MAPLE_AUTH_MODE?.trim() ||
					process.env.MAPLE_AUTH_MODE?.trim() ||
					"self_hosted",
				VITE_CLERK_PUBLISHABLE_KEY:
					process.env.VITE_CLERK_PUBLISHABLE_KEY?.trim() ||
					process.env.CLERK_PUBLISHABLE_KEY?.trim() ||
					"",
				VITE_MAPLE_INGEST_KEY:
					process.env.VITE_MAPLE_INGEST_KEY?.trim() ||
					process.env.MAPLE_OTEL_PUBLIC_INGEST_KEY?.trim() ||
					"",
				// Stamped onto browser telemetry as `deployment.commit_sha` /
				// `service.version`; listed here so a SHA-only change (e.g. a rebase)
				// busts the build memo instead of serving a stale cached bundle.
				VITE_COMMIT_SHA: process.env.VITE_COMMIT_SHA?.trim() || "",
			},
		})

		const worker = yield* Cloudflare.Worker<{}, Cloudflare.AssetsWithHash>("app", {
			name: resolveWorkerName("web", stage),
			main: path.join(import.meta.dirname, "src", "worker.ts"),
			assets: { directory: build.outdir, hash: Output.map(build.hash, (h) => h.output ?? "") },
			placement: CLOUDFLARE_WORKER_PLACEMENT,
			url: true,
			domain: domains.web,
		})

		return worker
	})
