import path from "node:path"
import { Vite } from "alchemy/cloudflare"
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

export const createMapleWeb = async ({
	stage,
	domains,
	apiUrl,
	ingestUrl,
	flueChatUrl,
	electricSyncUrl,
}: CreateMapleWebOptions) => {
	if (!process.env.VITE_MAPLE_AUTH_MODE) {
		process.env.VITE_MAPLE_AUTH_MODE = process.env.MAPLE_AUTH_MODE?.trim() || "self_hosted"
	}

	if (!process.env.VITE_CLERK_PUBLISHABLE_KEY) {
		process.env.VITE_CLERK_PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY?.trim() || ""
	}

	if (!process.env.VITE_MAPLE_INGEST_KEY) {
		process.env.VITE_MAPLE_INGEST_KEY = process.env.MAPLE_OTEL_PUBLIC_INGEST_KEY?.trim() || ""
	}

	process.env.VITE_API_BASE_URL = apiUrl
	process.env.VITE_INGEST_URL = ingestUrl
	process.env.VITE_FLUE_CHAT_URL = flueChatUrl
	process.env.VITE_ELECTRIC_SYNC_URL = electricSyncUrl

	const website = await Vite("app", {
		name: resolveWorkerName("web", stage),
		adopt: true,
		cwd: import.meta.dirname,
		entrypoint: path.join(import.meta.dirname, "src", "worker.ts"),
		placement: CLOUDFLARE_WORKER_PLACEMENT,
		domains: domains.web ? [{ domainName: domains.web, adopt: true }] : undefined,
	})

	return website
}
