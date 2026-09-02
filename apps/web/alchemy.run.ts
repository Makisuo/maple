import path from "node:path"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Command from "alchemy/Command"
import * as Output from "alchemy/Output"
import * as Effect from "effect/Effect"
import {
	assertBindingParity,
	CLOUDFLARE_WORKER_PLACEMENT,
	resolveWorkerName,
	type MapleDomains,
	type MapleStage,
} from "@maple/infra/cloudflare"
import type { MapleApiWorker } from "../api/alchemy.run.ts"
import type { WebWorkerEnv } from "./src/worker-env.ts"

export interface CreateMapleWebOptions {
	stage: MapleStage
	domains: MapleDomains
	api: MapleApiWorker
	apiUrl: string
	ingestUrl: string
	electricSyncUrl: string
}

// The share-preview lookups ride the service binding worker-to-worker; the URL
// is still bound because bindings address requests by absolute URL, and a
// deployment without the binding falls back to fetching it over the public
// domain. A dev stage without an api domain binds neither, and previews
// degrade to the generic card.
const makeWorkerEnv = ({ api, apiUrl }: { api: MapleApiWorker; apiUrl: string }) => ({
	...(apiUrl === "" ? undefined : { MAPLE_API_BASE_URL: apiUrl }),
	API: api,
})

// Drift gate for `src/worker-env.ts`, whose Env is structural because the SPA's
// tsconfig cannot see `@cloudflare/workers-types` (see the note there). This
// program proves the deployed env satisfies what the worker reads; a renamed
// key or retyped value fails `tsc -p tsconfig.alchemy.json`. ASSETS is not in
// `env:` — the assets prop injects it — so the runtime type stands in for it.
assertBindingParity<
	WebWorkerEnv,
	Cloudflare.InferEnv<ReturnType<typeof makeWorkerEnv>> & { ASSETS: WebWorkerEnv["ASSETS"] }
>()

// The web dashboard is a Vite SPA: `vite build` emits a flat `dist/` and
// `src/worker.ts` is a tiny assets-fallback worker (unknown routes → SPA
// shell). The build runs through `Command.Build` so the VITE_* env is part of
// the memo hash — a stage's URLs changing re-runs the build even when no
// source file changed. vite.config.ts turns these process-env VITE_* values
// into `define` overrides that win over `.env*` files.
export const createMapleWeb = ({
	stage,
	domains,
	api,
	apiUrl,
	ingestUrl,
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

		const worker = yield* Cloudflare.Worker<ReturnType<typeof makeWorkerEnv>, Cloudflare.AssetsWithHash>(
			"app",
			{
				name: resolveWorkerName("web", stage),
				main: path.join(import.meta.dirname, "src", "worker.ts"),
				// The bundle bakes the URL in for the browser (VITE_API_BASE_URL
				// above); the Worker gets it too, plus the api service binding, for
				// the share-link social previews it resolves server-side before the
				// SPA ever boots.
				env: makeWorkerEnv({ api, apiUrl }),
				assets: {
					directory: build.outdir,
					hash: Output.map(build.hash, (h) => h.output ?? ""),
					// Deep links (/traces, /alerts, …) must serve the SPA shell at the
					// requested URL. Without this the binding 404s, worker.ts falls back
					// to an explicit /index.html fetch, and the assets layer's
					// auto-trailing-slash normalization answers that with a 307 to "/" —
					// hard reloads on any deep path land on the dashboard root.
					notFoundHandling: "single-page-application",
				},
				placement: CLOUDFLARE_WORKER_PLACEMENT,
				workersDev: true,
				domain: domains.web,
			},
		)

		return worker
	})
