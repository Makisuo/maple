import { defineConfig } from "@flue/runtime/config"

/**
 * Cloudflare Workers build. `root`/`output` are gone in Flue 2 — Vite owns both
 * (see `vite.config.ts`). Agents are discovered from `src/` by the `'use agent'`
 * directive rather than by directory convention.
 *
 * `providers` narrows the pi-ai providers compiled into the generated Worker
 * entry. Every model here is Workers AI (`cloudflare/@cf/...` via `env.AI.run`),
 * so shipping the anthropic/openai/etc. factories would be dead bundle weight.
 *
 * `tracing: false` opts out of the generated entry's default Cloudflare tracing:
 * `app.ts` installs its own OpenTelemetry instrumentation that exports to Maple's
 * ingest, and running both would double-record every model and tool call.
 */
export default defineConfig({
	target: "cloudflare",
	providers: ["cloudflare"],
	tracing: false,
})
