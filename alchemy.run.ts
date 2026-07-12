import { appendFileSync } from "node:fs"
import alchemy from "alchemy"
import { CloudflareStateStore } from "alchemy/state"
import { parseMapleStage, resolveMapleDomains } from "@maple/infra/cloudflare"
import { createAlertingWorker } from "./apps/alerting/alchemy.run.ts"
import { createMapleApi } from "./apps/api/alchemy.run.ts"
import { createChatFlueWorker } from "./apps/chat-flue/alchemy.run.ts"
import { createElectricSyncWorker } from "./apps/electric-sync/alchemy.run.ts"
import { createLandingWorker } from "./apps/landing/alchemy.run.ts"
import { createLocalUiWorker } from "./apps/local-ui/alchemy.run.ts"
import { createMapleWeb } from "./apps/web/alchemy.run.ts"

const requireEnv = (key: string): string => {
	const value = process.env[key]?.trim()
	if (!value) {
		throw new Error(`Missing required deployment env: ${key}`)
	}
	return value
}

const app = await alchemy("maple", {
	password: requireEnv("ALCHEMY_PASSWORD"),
	...(process.env.ALCHEMY_STATE_TOKEN ? { stateStore: (scope) => new CloudflareStateStore(scope) } : {}),
})

const stage = parseMapleStage(app.stage)
const domains = resolveMapleDomains(stage)

const { worker: api, db: mapleDb } = await createMapleApi({ stage, domains })

const resolvedApiUrl = domains.api ? `https://${domains.api}` : api.url
if (!resolvedApiUrl) {
	throw new Error("api worker deployed without a url — set `url: true` or provide a custom domain")
}

const chatFlue = await createChatFlueWorker({
	stage,
	domains,
	mapleApiUrl: resolvedApiUrl,
})

const resolvedChatUrl = domains.chat ? `https://${domains.chat}` : chatFlue.url
if (!resolvedChatUrl) {
	throw new Error("chat-flue worker deployed without a url — set `url: true` or provide a custom domain")
}

// ingest is not currently deployed via alchemy; for non-custom-domain stages,
// fall back to a caller-supplied env var or the public Maple ingest endpoint.
const resolvedIngestUrl = domains.ingest
	? `https://${domains.ingest}`
	: process.env.VITE_INGEST_URL?.trim() || "https://ingest.maple.dev"

// Standalone ElectricSQL shape-proxy worker (DB-free). Created before web so its
// public origin can be baked into the web build (VITE_ELECTRIC_SYNC_URL).
const electricSync = await createElectricSyncWorker({ stage, domains })

const resolvedElectricSyncUrl = domains.sync ? `https://${domains.sync}` : electricSync.url
if (!resolvedElectricSyncUrl) {
	throw new Error("electric-sync worker deployed without a url — set `url: true` or provide a custom domain")
}

const web = await createMapleWeb({
	stage,
	domains,
	apiUrl: resolvedApiUrl,
	ingestUrl: resolvedIngestUrl,
	flueChatUrl: resolvedChatUrl,
	electricSyncUrl: resolvedElectricSyncUrl,
})

const landing = await createLandingWorker({ stage, domains })

const localUi = await createLocalUiWorker({ stage, domains })

const alerting = await createAlertingWorker({ stage, domains, mapleDb })

const summary = {
	stage: app.stage,
	apiUrl: resolvedApiUrl,
	chatUrl: resolvedChatUrl,
	ingestUrl: resolvedIngestUrl,
	electricSyncUrl: resolvedElectricSyncUrl,
	webUrl: domains.web ? `https://${domains.web}` : web.url,
	landingUrl: domains.landing ? `https://${domains.landing}` : landing.url,
	localUiUrl: domains.local ? `https://${domains.local}` : localUi.url,
	alertingWorker: alerting.name,
}

console.log(summary)

// In GitHub Actions, expose the deployed URLs as step outputs so the workflow
// can attach the web preview to the PR as a clickable deployment.
if (process.env.GITHUB_OUTPUT) {
	appendFileSync(
		process.env.GITHUB_OUTPUT,
		`${[
			`web_url=${summary.webUrl ?? ""}`,
			`api_url=${summary.apiUrl ?? ""}`,
			`chat_url=${summary.chatUrl ?? ""}`,
			`landing_url=${summary.landingUrl ?? ""}`,
		].join("\n")}\n`,
	)
}

await app.finalize()
