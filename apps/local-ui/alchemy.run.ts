/**
 * The local-mode dashboard SPA as an alchemy class, yielded by the root stack
 * (`yield* LocalUi`); its props read `MapleStack`. Deploying this to
 * `local.maple.dev` decouples UI updates from `maple` binary releases — the
 * binary points users here by default and embeds this same build only as the
 * `--offline` fallback.
 *
 * It's a plain Vite SPA that builds flat to `dist/` (the `maple` binary embeds
 * that same `dist/` via rust-embed — see `apps/cli/src/server/ui-assets.ts`),
 * so the build stays a plain `vite build` via Command.Build and the worker
 * serves the flat `dist/` as assets with the SPA fallback in `src/worker.ts`.
 */
import path from "node:path"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Command from "alchemy/Command"
import * as Output from "alchemy/Output"
import * as Effect from "effect/Effect"
import {
	assetWorkerObservability,
	CLOUDFLARE_WORKER_PLACEMENT,
	MapleStack,
	resolveWorkerName,
	WorkersObservabilityDestinations,
} from "@maple/infra/cloudflare"

const props = Effect.gen(function* () {
	const { stage, domains } = yield* MapleStack
	const destinations = yield* WorkersObservabilityDestinations
	const build = yield* Command.Build("local-ui-build", {
		command: "bun run build",
		cwd: import.meta.dirname,
		outdir: "dist",
	})
	return {
		name: resolveWorkerName("local-ui", stage),
		main: path.join(import.meta.dirname, "src", "worker.ts"),
		assets: { directory: build.outdir, hash: Output.map(build.hash, (h) => h.output ?? "") },
		placement: CLOUDFLARE_WORKER_PLACEMENT,
		observability: assetWorkerObservability(destinations),
		workersDev: true,
		domain: domains.local,
	}
})

export default class LocalUi extends Cloudflare.Worker<LocalUi>()("local-ui", props) {}
