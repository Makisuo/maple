import path from "node:path"
import alchemy from "alchemy"
import { DurableObjectNamespace, Worker, type D1Database } from "alchemy/cloudflare"
import type { MapleDomains, MapleStage } from "@maple/infra/cloudflare"
import { formatMapleStage, resolveWorkerName } from "@maple/infra/cloudflare"

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

const optionalSecret = (key: string): Record<string, ReturnType<typeof alchemy.secret>> => {
	const value = process.env[key]?.trim()
	return value ? { [key]: alchemy.secret(value) } : {}
}

export interface CreateChatAgentWorkerOptions {
	stage: MapleStage
	domains: MapleDomains
	mapleApiUrl: string
	mapleDb: D1Database
}

export const createChatAgentWorker = async ({
	stage,
	domains,
	mapleApiUrl,
	mapleDb,
}: CreateChatAgentWorkerOptions) => {
	const chatAgentDO = DurableObjectNamespace("chat-agent-do", {
		className: "ChatAgent",
		sqlite: true,
	})

	const worker = await Worker("chat-agent", {
		name: resolveWorkerName("chat-agent", stage),
		cwd: import.meta.dirname,
		entrypoint: path.join(import.meta.dirname, "src", "index.ts"),
		compatibility: "node",
		url: true,
		adopt: true,
		domains: domains.chat ? [{ domainName: domains.chat, adopt: true }] : undefined,
		bindings: {
			ChatAgent: chatAgentDO,
			MAPLE_DB: mapleDb,
			MAPLE_API_URL: mapleApiUrl,
			TINYBIRD_HOST: requireEnv("TINYBIRD_HOST"),
			TINYBIRD_TOKEN: alchemy.secret(requireEnv("TINYBIRD_TOKEN")),
			MAPLE_AUTH_MODE: process.env.MAPLE_AUTH_MODE?.trim() || "self_hosted",
			MAPLE_DEFAULT_ORG_ID: process.env.MAPLE_DEFAULT_ORG_ID?.trim() || "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: alchemy.secret(requireEnv("MAPLE_INGEST_KEY_ENCRYPTION_KEY")),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: alchemy.secret(requireEnv("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY")),
			MAPLE_INGEST_PUBLIC_URL:
				process.env.MAPLE_INGEST_PUBLIC_URL?.trim() || "https://ingest.maple.dev",
			MAPLE_APP_BASE_URL: process.env.MAPLE_APP_BASE_URL?.trim() || "https://app.maple.dev",
			INTERNAL_SERVICE_TOKEN: alchemy.secret(process.env.INTERNAL_SERVICE_TOKEN),
			OPENROUTER_API_KEY: alchemy.secret(process.env.OPENROUTER_API_KEY),
			...optionalPlain("MAPLE_ENDPOINT"),
			...optionalPlain("MAPLE_ENVIRONMENT", formatMapleStage(stage)),
			...optionalPlain("COMMIT_SHA"),
			MAPLE_INGEST_KEY: alchemy.secret(requireEnv("MAPLE_INGEST_KEY")),
			...optionalSecret("MAPLE_ROOT_PASSWORD"),
			...optionalSecret("CLERK_SECRET_KEY"),
			...optionalPlain("CLERK_PUBLISHABLE_KEY"),
			...optionalSecret("CLERK_JWT_KEY"),
			...optionalSecret("AUTUMN_SECRET_KEY"),
			...optionalPlain("AUTUMN_API_URL", "https://api.useautumn.com"),
			...optionalSecret("SD_INTERNAL_TOKEN"),
			...optionalSecret("RESEND_API_KEY"),
			RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL?.trim() || "Maple <notifications@maple.dev>",
		},
	})

	return worker
}
