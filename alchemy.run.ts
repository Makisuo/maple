import { appendFileSync } from "node:fs"
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import { formatMapleStage, parseMapleStage, resolveMapleDomains } from "@maple/infra/cloudflare"
import { createAlertingWorker } from "./apps/alerting/alchemy.run.ts"
import { createMapleApi } from "./apps/api/alchemy.run.ts"
import { createChatFlueWorker } from "./apps/chat-flue/alchemy.run.ts"
import { createElectricSyncWorker } from "./apps/electric-sync/alchemy.run.ts"
import { createLandingWorker } from "./apps/landing/alchemy.run.ts"
import { createLocalUiWorker } from "./apps/local-ui/alchemy.run.ts"
import { createMapleWeb } from "./apps/web/alchemy.run.ts"

// v1 read the account id from CLOUDFLARE_DEFAULT_ACCOUNT_ID (the name Infisical
// still defines); v2's auth provider reads CLOUDFLARE_ACCOUNT_ID. Bridge the
// old name so CI keeps working without an Infisical rename.
if (!process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID) {
	process.env.CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID
}

// Inter-app URLs must be plain strings at plan time: alchemy v2 resource
// attributes (e.g. `worker.url`) are lazy Outputs that only resolve when fed
// into other resources' props — they cannot be string-interpolated here. Every
// deployed stage therefore gets custom domains (see resolveMapleDomains); dev
// stages fall back to env-supplied URLs (cloud-deploying a dev stage is rare —
// local dev runs through wrangler/portless instead).
const resolveUrl = (domain: string | undefined, envKey: string, fallback = ""): string =>
	domain ? `https://${domain}` : process.env[envKey]?.trim() || fallback

export default Alchemy.Stack(
	"maple",
	{
		providers: Cloudflare.providers(),
		// Shared account-wide state store (Worker + DO SQLite) — bootstrapped once
		// per Cloudflare account (`alchemy bootstrap cloudflare` or the first
		// `deploy --yes`). ALCHEMY_LOCAL_STATE=1 opts into .alchemy/ file state for
		// throwaway local experiments (dev stages) without touching the account.
		state: process.env.ALCHEMY_LOCAL_STATE ? Alchemy.localState() : Cloudflare.state(),
	},
	Effect.gen(function* () {
		const stage = parseMapleStage(yield* Alchemy.Stage)
		const domains = resolveMapleDomains(stage)

		const apiUrl = resolveUrl(domains.api, "MAPLE_API_BASE_URL")
		const chatUrl = resolveUrl(domains.chat, "MAPLE_CHAT_BASE_URL")
		const electricSyncUrl = resolveUrl(domains.sync, "MAPLE_ELECTRIC_SYNC_URL")
		// ingest is not deployed via alchemy; for non-custom-domain stages, fall
		// back to a caller-supplied env var or the public Maple ingest endpoint.
		const ingestUrl = resolveUrl(domains.ingest, "VITE_INGEST_URL", "https://ingest.maple.dev")

		// chat-flue deploys before api so api can service-bind the real worker (the
		// v1 WorkerStub cycle-breaker is gone — chat-flue's api URL is now static).
		const chatFlue = yield* createChatFlueWorker({ stage, domains, mapleApiUrl: apiUrl })

		const { worker: api, db: mapleDb } = yield* createMapleApi({ stage, domains, chatFlue })

		// Standalone ElectricSQL shape-proxy worker (DB-free); its public origin is
		// baked into the web build (VITE_ELECTRIC_SYNC_URL).
		const electricSync = yield* createElectricSyncWorker({ stage, domains })

		const web = yield* createMapleWeb({
			stage,
			domains,
			apiUrl,
			ingestUrl,
			flueChatUrl: chatUrl,
			electricSyncUrl,
		})

		const landing = yield* createLandingWorker({ stage, domains })

		const localUi = yield* createLocalUiWorker({ stage, domains })

		const alerting = yield* createAlertingWorker({ stage, domains, mapleDb })

		const summary = {
			stage: formatMapleStage(stage),
			apiUrl,
			chatUrl,
			ingestUrl,
			electricSyncUrl,
			webUrl: domains.web ? `https://${domains.web}` : "",
			landingUrl: domains.landing ? `https://${domains.landing}` : "",
			localUiUrl: domains.local ? `https://${domains.local}` : "",
		}

		// In GitHub Actions, expose the deployed URLs as step outputs so the
		// workflow can attach the web preview to the PR as a clickable deployment.
		yield* Effect.sync(() => {
			if (process.env.GITHUB_OUTPUT) {
				appendFileSync(
					process.env.GITHUB_OUTPUT,
					`${[
						`web_url=${summary.webUrl}`,
						`api_url=${summary.apiUrl}`,
						`chat_url=${summary.chatUrl}`,
						`landing_url=${summary.landingUrl}`,
					].join("\n")}\n`,
				)
			}
		})

		// Reference the remaining workers so nothing is tree-shaken out of the plan
		// and the summary carries their identity for the CLI output.
		return {
			...summary,
			electricSyncWorker: electricSync.workerName,
			webWorker: web.workerName,
			landingWorker: landing.workerName,
			localUiWorker: localUi.workerName,
			alertingWorker: alerting.workerName,
		}
	}),
)
