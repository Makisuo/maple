export type MapleStage =
	| { kind: "prd" }
	| { kind: "stg" }
	| { kind: "pr"; prNumber: number }
	| { kind: "dev"; name: string }

const PR_STAGE_RE = /^pr-(\d+)$/
// Underscores allowed so alchemy's default `dev_${USER}` stage parses as a dev stage.
const DEV_STAGE_RE = /^[a-z0-9][a-z0-9_-]*$/

export interface MapleDomains {
	web?: string
	landing?: string
	api?: string
	ingest?: string
	chat?: string
	/** Standalone ElectricSQL shape-proxy worker (`apps/electric-sync`). */
	sync?: string
	/** Auto-updating local-mode dashboard SPA (the `maple` binary points users here by default). */
	local?: string
}

export const CLOUDFLARE_WORKER_PLACEMENT = { region: "aws:us-east-1" } as const

const PRD_DOMAINS: MapleDomains = {
	web: "app.maple.dev",
	api: "api.maple.dev",
	ingest: "ingest.maple.dev",
	chat: "chat.maple.dev",
	sync: "sync.maple.dev",
	landing: "maple.dev",
	local: "local.maple.dev",
}

const STG_DOMAINS: MapleDomains = {
	web: "staging.maple.dev",
	api: "api-staging.maple.dev",
	ingest: "ingest-staging.maple.dev",
	chat: "chat-staging.maple.dev",
	sync: "sync-staging.maple.dev",
	landing: "staging-landing.maple.dev",
	local: "local-staging.maple.dev",
}

export function parseMapleStage(stage: string): MapleStage {
	const normalized = stage.trim().toLowerCase()

	if (normalized === "prd") {
		return { kind: "prd" }
	}

	if (normalized === "stg") {
		return { kind: "stg" }
	}

	const prMatch = normalized.match(PR_STAGE_RE)
	if (prMatch) {
		const prNumber = Number(prMatch[1])
		if (Number.isSafeInteger(prNumber) && prNumber > 0) {
			return { kind: "pr", prNumber }
		}
	}

	if (DEV_STAGE_RE.test(normalized)) {
		// Underscores are accepted (alchemy's default stage is `dev_${USER}`) but
		// normalized to hyphens: `name` flows into Cloudflare worker/Hyperdrive
		// names, which only allow [a-z0-9-].
		return { kind: "dev", name: normalized.replaceAll("_", "-") }
	}

	throw new Error(
		`Unsupported deployment stage "${stage}". Expected prd, stg, pr-<number>, or a dev stage name matching [a-z0-9][a-z0-9_-]*.`,
	)
}

export function formatMapleStage(stage: MapleStage): string {
	switch (stage.kind) {
		case "prd":
			return "prd"
		case "stg":
			return "stg"
		case "pr":
			return `pr-${stage.prNumber}`
		case "dev":
			return stage.name
	}
}

export function resolveDeploymentEnvironment(stage: MapleStage): string {
	switch (stage.kind) {
		case "prd":
			return "production"
		case "stg":
			return "staging"
		case "pr":
			return `pr-${stage.prNumber}`
		case "dev":
			return "development"
	}
}

export function resolveMapleDomains(stage: MapleStage): MapleDomains {
	switch (stage.kind) {
		case "prd":
			return PRD_DOMAINS
		case "stg":
			return STG_DOMAINS
		case "pr":
			// Give PR previews stable, secret-free URLs. The default workers.dev URL
			// embeds the Cloudflare account subdomain, which Infisical masks as a
			// secret — GitHub then refuses to set the environment URL. Custom domains
			// under the `maple.dev` zone have no secret in them. They also keep every
			// inter-app URL a plain string at deploy time, which alchemy v2 requires:
			// resource attributes like `worker.url` are lazy Outputs that cannot be
			// string-interpolated into another worker's env. landing/local-ui have no
			// pr domains (nothing links to them from previews).
			return {
				web: `app-pr-${stage.prNumber}.maple.dev`,
				api: `api-pr-${stage.prNumber}.maple.dev`,
				chat: `chat-pr-${stage.prNumber}.maple.dev`,
				sync: `sync-pr-${stage.prNumber}.maple.dev`,
			}
		case "dev":
			return {}
	}
}

/**
 * Dashboard-managed Hyperdrive configs, bound by ID (v1's `HyperdriveRef`).
 * The origin/credentials are managed in the Cloudflare dashboard — deploys
 * never see or rewrite the database connection. Stages returning undefined
 * get an alchemy-managed per-branch Hyperdrive pushed from MAPLE_PG_URL.
 * Config IDs are not secrets.
 */
export function resolveHyperdriveRefId(stage: MapleStage): string | undefined {
	switch (stage.kind) {
		case "prd":
			// `maple-prd` — origin: PlanetScale `main` branch.
			return "ad4c487838594b89810b23e5fb14e129"
		case "stg":
			// TEMPORARY: staging shares prod's `maple-prd` config (owner decision,
			// 2026-07-14) — stg workers therefore read/write the PRODUCTION
			// database and the stg alerting crons overlap prod's. Replace with a
			// dedicated `maple-stg` config (PlanetScale `stg` branch) ASAP.
			return "ad4c487838594b89810b23e5fb14e129"
		case "pr":
		case "dev":
			return undefined
	}
}

export function resolveHyperdriveName(stage: MapleStage): string {
	switch (stage.kind) {
		case "prd":
			// Pre-configured in the Cloudflare dashboard (origin/credentials managed
			// there); the prod deploy references it by this name. See alchemy.run.ts.
			return "maple-prd"
		case "stg":
			return "maple-db-stg"
		case "pr":
			return `maple-db-pr-${stage.prNumber}`
		case "dev":
			return `maple-db-dev-${stage.name}`
	}
}

/**
 * PlanetScale Postgres branch backing a stage. One database (`maple-api`)
 * with a fully-isolated branch per stage; pr branches are created/destroyed
 * by scripts/planetscale-pr-branch.ts. Dev stages have no managed branch —
 * local dev runs against the docker-compose Postgres.
 */
export function resolvePlanetScaleBranch(stage: MapleStage): string | undefined {
	switch (stage.kind) {
		case "prd":
			return "main"
		case "stg":
			return "stg"
		case "pr":
			return `pr-${stage.prNumber}`
		case "dev":
			return undefined
	}
}

export function resolveWorkerName(base: string, stage: MapleStage): string {
	switch (stage.kind) {
		case "prd":
			return `maple-${base}`
		case "stg":
			return `maple-${base}-stg`
		case "pr":
			return `maple-${base}-pr-${stage.prNumber}`
		case "dev":
			return `maple-${base}-dev-${stage.name}`
	}
}
