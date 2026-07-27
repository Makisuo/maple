#!/usr/bin/env bun
/**
 * Sweep orphaned per-PR Cloudflare Hyperdrive configs.
 *
 *   bun scripts/hyperdrive-orphan-sweep.ts
 *
 * PR-preview stages get an alchemy-managed Hyperdrive config named
 * `maple-db-pr-<n>` (packages/infra/src/cloudflare/stage.ts,
 * resolveHyperdriveName). `alchemy destroy --stage pr-<n>` deletes it on PR
 * close — but the close-event teardown is best-effort (see
 * cleanup-preview-orphans.yml), and worse than the other resources: close
 * runs execute the PR branch's OWN workflow/alchemy.run.ts version, and
 * branches predating the placeholder-MAPLE_PG_URL destroy fix fail with
 * "Missing required deployment env: MAPLE_PG_URL" on every rerun, forever
 * (runs 29737841130/29528075804 attempt 2). The account allows 25 Hyperdrive
 * configs total, so leaked `maple-db-pr-*` configs eventually block EVERY new
 * PR preview with "This account has reached its limit for how many
 * Hyperdrives it can have (25)" (run 30077724144, PR #257).
 *
 * There is no up/down here — alchemy owns the config's lifecycle; this script
 * exists only as the sweep safety net. Deletion is double-gated like the
 * sibling sweeps: the config name must match `maple-db-pr-<digits>` exactly
 * (prd `maple-prd`, stg `maple-db-stg`, and dev `maple-db-dev-<name>` can
 * never match), AND the GitHub API must affirmatively report that PR closed —
 * unknown/open → keep. Deleting a config out from under a later alchemy
 * destroy of the same stage is fine: alchemy tolerates already-deleted
 * resources.
 *
 * Auth: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (the same credentials
 * the deploy workflow's alchemy steps use), GITHUB_REPOSITORY +
 * GITHUB_TOKEN/GH_TOKEN for the PR-state gate.
 */

const FAILURE = 1

const fail = (message: string): never => {
	console.error(`✗ ${message}`)
	process.exit(FAILURE)
}

const requireEnv = (key: string): string => {
	const value = process.env[key]?.trim()
	if (!value) {
		return fail(`Missing required env: ${key}`)
	}
	return value
}

/**
 * PR state via the GitHub REST API. Returns "unknown" when the API call
 * fails — callers must treat "unknown" as "don't delete", never as "closed".
 * Same contract as the sibling sweeps in scripts/planetscale-pr-branch.ts.
 */
const fetchPrState = async (prNumber: string): Promise<"open" | "closed" | "unknown"> => {
	const repo = process.env.GITHUB_REPOSITORY?.trim()
	const token = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN)?.trim()
	if (!repo || !token) return "unknown"
	try {
		const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		})
		if (!response.ok) {
			console.log(`⚠ Could not look up PR #${prNumber} state (HTTP ${response.status})`)
			return "unknown"
		}
		const parsed = (await response.json()) as { state?: string }
		return parsed.state === "open" ? "open" : parsed.state === "closed" ? "closed" : "unknown"
	} catch (error) {
		console.log(
			`⚠ Could not look up PR #${prNumber} state (${error instanceof Error ? error.message : String(error)})`,
		)
		return "unknown"
	}
}

interface HyperdriveConfig {
	readonly id?: string
	readonly name?: string
}

const cfRequest = async (
	token: string,
	path: string,
	init?: RequestInit,
): Promise<{ ok: boolean; status: number; result: unknown; errors: unknown }> => {
	const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...init?.headers,
		},
	})
	const body = (await response.json().catch(() => ({}))) as {
		success?: boolean
		result?: unknown
		errors?: unknown
	}
	return {
		ok: response.ok && body.success !== false,
		status: response.status,
		result: body.result,
		errors: body.errors,
	}
}

const main = async (): Promise<void> => {
	// Same guard as the sibling sweeps: without the PR-state gate every config
	// resolves to "unknown" and the run green-no-ops forever.
	if (
		!process.env.GITHUB_REPOSITORY?.trim() ||
		!(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN)?.trim()
	) {
		fail("sweep requires GITHUB_REPOSITORY and GITHUB_TOKEN (or GH_TOKEN) to check PR state")
	}
	const token = requireEnv("CLOUDFLARE_API_TOKEN")
	const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID")

	const listed = await cfRequest(token, `/accounts/${accountId}/hyperdrive/configs`)
	if (!listed.ok) {
		fail(`Could not list Hyperdrive configs (HTTP ${listed.status}): ${JSON.stringify(listed.errors)}`)
	}
	// A success response whose `result` isn't an array means the API shape
	// changed under us — fail loudly rather than green-no-op'ing the safety net.
	if (!Array.isArray(listed.result)) {
		fail(`Unexpected Hyperdrive list response shape (result is ${typeof listed.result}, expected array)`)
	}
	const configs = listed.result as ReadonlyArray<HyperdriveConfig>
	const candidates = configs
		.map((config) => ({
			id: config.id ?? "",
			name: config.name ?? "",
			match: /^maple-db-pr-(\d+)$/.exec(config.name ?? ""),
		}))
		.filter(
			(entry): entry is { id: string; name: string; match: RegExpExecArray } =>
				entry.match !== null && entry.id.length > 0,
		)
	console.log(
		`Found ${configs.length} Hyperdrive config(s), ${candidates.length} maple-db-pr-*: ${candidates.map((c) => c.name).join(", ") || "—"}`,
	)

	const failures: string[] = []
	for (const { id, name, match } of candidates) {
		const state = await fetchPrState(match[1] as string)
		if (state === "open") {
			console.log(`… keeping ${name} (PR #${match[1]} is open)`)
			continue
		}
		if (state === "unknown") {
			console.log(`⚠ skipping ${name} (PR #${match[1]} state unknown)`)
			continue
		}
		console.log(`… deleting orphan ${name} (PR #${match[1]} is closed)`)
		const removed = await cfRequest(token, `/accounts/${accountId}/hyperdrive/configs/${id}`, {
			method: "DELETE",
		})
		if (!removed.ok && removed.status !== 404) {
			console.log(`✗ delete failed (HTTP ${removed.status}): ${JSON.stringify(removed.errors)}`)
			failures.push(name)
		}
	}
	if (failures.length > 0) {
		fail(`Failed to delete orphan Hyperdrive config(s): ${failures.join(", ")}`)
	}
	console.log("✓ Sweep complete")
}

await main()
