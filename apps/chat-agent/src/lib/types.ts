import type { ChatAgent } from "../index"

export interface Env {
	ChatAgent: DurableObjectNamespace<ChatAgent>
	MAPLE_DB: D1Database
	MAPLE_API_URL: string
	TINYBIRD_HOST: string
	TINYBIRD_TOKEN: string
	MAPLE_AUTH_MODE: string
	MAPLE_DEFAULT_ORG_ID: string
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: string
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: string
	MAPLE_INGEST_PUBLIC_URL: string
	MAPLE_APP_BASE_URL: string
	CLERK_PUBLISHABLE_KEY?: string
	INTERNAL_SERVICE_TOKEN: string
	MAPLE_ROOT_PASSWORD?: string
	CLERK_SECRET_KEY?: string
	CLERK_JWT_KEY?: string
	AUTUMN_SECRET_KEY?: string
	AUTUMN_API_URL?: string
	SD_INTERNAL_TOKEN?: string
	RESEND_API_KEY?: string
	RESEND_FROM_EMAIL?: string
	OPENROUTER_API_KEY: string
}
