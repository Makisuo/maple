import path from "node:path"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Command from "alchemy/Command"
import * as Output from "alchemy/Output"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import type { MapleDomains, MapleStage } from "@maple/infra/cloudflare"
import {
	CLOUDFLARE_WORKER_PLACEMENT,
	resolveDeploymentEnvironment,
	resolveWorkerName,
} from "@maple/infra/cloudflare"

const requireEnv = (key: string): string => {
	const value = process.env[key]?.trim()
	if (!value) {
		throw new Error(`Missing required deployment env: ${key}`)
	}
	return value
}

const optionalPlain = (key: string, fallback?: string): Record<string, string> => {
	const value = process.env[key]?.trim() || fallback
	return value ? { [key]: value } : {}
}

const optionalSecret = (key: string): Record<string, Redacted.Redacted<string>> => {
	const value = process.env[key]?.trim()
	return value ? { [key]: Redacted.make(value) } : {}
}

export interface CreateChatFlueWorkerOptions {
	stage: MapleStage
	domains: MapleDomains
	mapleApiUrl: string
}


/**
 * Deploy the Flue chat worker (`apps/chat-flue`) via alchemy, consistent with
 * the rest of the stack.
 *
 * Flue builds its own Cloudflare entrypoint + Durable Object classes, so a
 * `Command.Build` runs `flue build` first (memoized on the app's source files,
 * skipped on destroy), then the Worker deploys the prebuilt bundle with
 * `bundle: false` (alchemy uploads `index.js` + the code-split `assets/*.js`
 * modules as-is). Alchemy owns the bindings here — the generated
 * `dist/.../wrangler.json` vars and `.dev.vars` are NOT read (only `.js`/`.mjs`
 * are uploaded), so no local secret leaks into the deploy. Keep the DO binding
 * NAMES and class names in sync with the generated
 * `dist/maple_chat_flue/wrangler.json`.
 *
 * Manual fallback (Flue-native): `cd apps/chat-flue && bun run build &&
 * wrangler deploy --config dist/maple_chat_flue/wrangler.json`.
 */
export const createChatFlueWorker = ({ stage, domains, mapleApiUrl }: CreateChatFlueWorkerOptions) =>
	Effect.gen(function* () {
		// Flue generates the Worker entrypoint + DO classes; build before deploy.
		const build = yield* Command.Build("chat-flue-build", {
			command: "bun run build",
			cwd: import.meta.dirname,
			outdir: path.join("dist", "maple_chat_flue"),
		})

		// Flue-generated Durable Objects. Binding names come from the `env` keys
		// below and class names must match the exports of the built `index.js`.
		// v2 provisions new DO classes as SQLite-backed by default (the v1
		// `sqlite: true` prop is gone).
		const chatAgent = Cloudflare.DurableObject("flue-maple-chat-agent", {
			className: "FlueMapleChatAgent",
		})
		const triageWorkflow = Cloudflare.DurableObject("flue-triage-workflow", {
			className: "FlueTriageWorkflow",
		})
		const registry = Cloudflare.DurableObject("flue-registry", {
			className: "FlueRegistry",
		})

		const worker = yield* Cloudflare.Worker("chat-flue", {
			name: resolveWorkerName("chat-flue", stage),
			// Derived from the Build output so the Worker upload depends on (and
			// waits for) the flue build.
			main: Output.map(build.outdir, (outdir) => path.resolve(outdir, "index.js")),
			// Deploy Flue's prebuilt bundle as-is (index.js + assets/*.js modules).
			bundle: false,
			rules: [{ globs: ["**/*.js", "**/*.mjs"] }],
			compatibility: { date: "2026-06-01", flags: ["nodejs_compat"] },
			placement: CLOUDFLARE_WORKER_PLACEMENT,
			// Workers Observability. `traces.enabled` is required for the `tracing.enterSpan`
			// custom spans in src/agents/maple-chat.ts to emit; the `"maple"` destination
			// forwards both logs and traces over Cloudflare's native pipeline → Maple ingest
			// (the same path the existing auto-spans use, unlike the @flue/opentelemetry
			// export which doesn't flush reliably from DO isolates). `"maple"` is the
			// account-level telemetry destination id.
			observability: {
				enabled: true,
				logs: { enabled: true, invocationLogs: true, destinations: ["maple"] },
				traces: { enabled: true, destinations: ["maple"] },
			},
			url: true,
			domain: domains.chat,
			env: {
				// Workers AI (`env.AI`, the v1 `Ai()` binding). v2 emits the
				// `{ type: "ai" }` binding by attaching an AI Gateway resource — the
				// gateway also fronts model calls with caching/rate-limits/logging.
				// NOTE: the deploy token needs the account-level "AI Gateway: Edit"
				// permission for this resource.
				AI: Cloudflare.AI.Gateway("chat-flue-ai"),
				FLUE_MAPLE_CHAT_AGENT: chatAgent,
				FLUE_TRIAGE_WORKFLOW: triageWorkflow,
				FLUE_REGISTRY: registry,
				MAPLE_API_URL: mapleApiUrl,
				INTERNAL_SERVICE_TOKEN: Redacted.make(requireEnv("INTERNAL_SERVICE_TOKEN")),
				// OpenTelemetry → Maple ingest. Provide the internal-org ingest key so
				// chat-flue spans land beside `maple-api`; telemetry no-ops when unset.
				...optionalSecret("MAPLE_INGEST_KEY"),
				...optionalPlain("MAPLE_ENDPOINT"),
				...optionalPlain("MAPLE_ENVIRONMENT", resolveDeploymentEnvironment(stage)),
				...optionalPlain("MAPLE_CHAT_MODEL"),
				...optionalPlain("MAPLE_TRIAGE_MODEL"),
				...optionalPlain("MAPLE_AUTH_MODE", "self_hosted"),
				...optionalSecret("MAPLE_ROOT_PASSWORD"),
				...optionalSecret("CLERK_SECRET_KEY"),
				...optionalPlain("CLERK_PUBLISHABLE_KEY"),
				...optionalSecret("CLERK_JWT_KEY"),
			},
		})

		return worker
	})
