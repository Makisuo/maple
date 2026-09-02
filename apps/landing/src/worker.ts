/**
 * The marketing site's Worker in alchemy's single-module form: this file is
 * both the resource the root stack yields (`yield* Landing`) and the bundle
 * alchemy deploys (`main: import.meta.url`). The Astro build is yielded from
 * the props, and every request goes to `./handler` — the markdown-twin
 * negotiation over the assets — which stays a plain function so its tests
 * need no Worker runtime.
 */
import {
	assetWorkerObservability,
	CLOUDFLARE_WORKER_PLACEMENT,
	MapleStack,
	resolveWorkerName,
	WorkersObservabilityDestinations,
} from "@maple/infra/cloudflare"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Command from "alchemy/Command"
import * as Output from "alchemy/Output"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { type AssetsBinding, handleRequest } from "./handler"

/**
 * Alchemy evaluates a Worker's props wherever the class is yielded — the
 * deployed bundle included, where they are inert. `__ALCHEMY_RUNTIME__` folds to
 * `true` there, so the stack-side branch below, and the `@maple/infra` and
 * `alchemy/Command` modules only it reaches, are dead-code-eliminated.
 */
const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const { stage, domains, urls } = yield* MapleStack
	const destinations = yield* WorkersObservabilityDestinations
	// Astro static build (memoized on the app's source files, skipped on destroy).
	const build = yield* Command.Build("landing-build", {
		command: "bun run build",
		cwd: new URL("..", import.meta.url).pathname,
		outdir: "dist",
		// Astro inlines PUBLIC_* at build time, so these belong to the build memo
		// hash — a key or endpoint change has to produce a new bundle. Same
		// ingest key the web app uses, so both surfaces land in one org and a
		// visitor's marketing and product sessions sit side by side.
		env: {
			PUBLIC_MAPLE_INGEST_KEY: process.env.MAPLE_OTEL_PUBLIC_INGEST_KEY ?? "",
			PUBLIC_INGEST_URL: urls.ingest,
		},
	})
	return {
		main: import.meta.url,
		name: resolveWorkerName("landing", stage),
		// The `assets` prop auto-adds the ASSETS binding the handler reads.
		assets: {
			directory: build.outdir,
			hash: Output.map(build.hash, (h) => h.output ?? ""),
			// Workers Assets serves a matching file *before* invoking the Worker,
			// so without this the handler never sees a request for a real page
			// and the `Accept: text/markdown` negotiation is dead code. Scoped to
			// extensionless paths — the ones with a `.md` twin. Anything with a
			// dot (hashed `/_astro/*`, images, the `.md` and `.txt` files
			// themselves) still comes straight off the asset layer with no Worker
			// invocation.
			runWorkerFirst: ["/*", "!/_astro/*", "!/*.*"],
		},
		compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
		placement: CLOUDFLARE_WORKER_PLACEMENT,
		observability: assetWorkerObservability(destinations),
		workersDev: true,
		domain: domains.landing,
	}
})

export default class Landing extends Cloudflare.Worker<Landing>()(
	"landing",
	props,
	Effect.succeed({
		fetch: Effect.gen(function* () {
			const request = yield* Cloudflare.Workers.Request
			const env = yield* Cloudflare.WorkerEnvironment
			const assets: AssetsBinding = env.ASSETS
			return HttpServerResponse.fromWeb(yield* Effect.promise(() => handleRequest(request, assets)))
		}),
	}),
) {}
