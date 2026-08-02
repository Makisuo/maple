#!/usr/bin/env bun
/**
 * Sweep orphaned per-PR Cloudflare Workers.
 *
 *   bun scripts/cloudflare-worker-orphan-sweep.ts
 *
 * PR-preview stages deploy every app as `maple-<base>-pr-<n>`
 * (packages/infra/src/cloudflare/stage.ts, resolveWorkerName). `alchemy
 * destroy --stage pr-<n>` deletes them on PR close — but the close-event
 * teardown is best-effort (see cleanup-preview-orphans.yml), so workers leak.
 *
 * Leaked workers are not just clutter: `maple-alerting-pr-<n>` workers keep
 * their cron triggers, and workers deployed from branches predating the
 * non-prod cron gate (#239, 2026-07-21) run the ticks unconditionally. They
 * ran silently against their own preview resources for months — until the
 * sibling sweeps (correctly) deleted those resources, after which every tick
 * failed with "Hyperdrive config deleted." into self-observability as
 * service.name="alerting", masquerading as a production alerting outage
 * (observed 2026-07-27..29).
 *
 * Worker ↔ queue deletion is mutually deadlocked: a Worker that is a
 * registered queue CONSUMER cannot be deleted (error 10064, NOT covered by
 * ?force=true — run 30406588392, and why the original close-event teardowns
 * wedged), and a queue referenced by a Worker's producer BINDING cannot be
 * deleted either (error 11005 — run 30407693847). Each preview api worker
 * both binds and consumes its stage's `maple-vcs-sync-pr-<n>` /
 * `maple-planetscale-webhooks-pr-<n>` queues (apps/api/alchemy.run.ts), so
 * the sweep breaks the cycle in three passes:
 *   1. detach the consumer registrations of closed-PR queues,
 *   2. delete the workers (their producer bindings die with them),
 *   3. delete the now-unreferenced queues.
 *
 * Deletion is double-gated like the sibling sweeps: the queue/worker name must
 * match `maple-<base>-pr-<digits>` exactly, where <base> may not contain
 * `-dev-` (prd `maple-api`, stg `maple-api-stg` can never match; a dev stage
 * named "pr-3" would produce `maple-api-dev-pr-3`, hence the -dev- exclusion),
 * AND the GitHub API must affirmatively report that PR closed — unknown/open →
 * keep. Worker deletes use ?force=true because preview workers service-bind
 * each other and hold Workflows and Durable Objects; without force those
 * deletions 400. The sweep matches on the `maple-<base>-pr-<digits>` shape
 * rather than an app allowlist, so it still reaches previews of apps that no
 * longer exist in this repo (e.g. leftover `maple-chat-flue-pr-<n>` workers
 * from before chat moved into apps/api). Deleting a queue or worker out from
 * under a later alchemy
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

interface WorkerScript {
	readonly id?: string
}

interface QueueInfo {
	readonly queue_id?: string
	readonly queue_name?: string
}

interface QueueConsumer {
	readonly consumer_id?: string
	readonly id?: string
	readonly script?: string
	readonly script_name?: string
}

const PR_RESOURCE_PATTERN = /^maple-((?:(?!-dev-).)+)-pr-(\d+)$/

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
	// Same guard as the sibling sweeps: without the PR-state gate every worker
	// resolves to "unknown" and the run green-no-ops forever.
	if (
		!process.env.GITHUB_REPOSITORY?.trim() ||
		!(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN)?.trim()
	) {
		fail("sweep requires GITHUB_REPOSITORY and GITHUB_TOKEN (or GH_TOKEN) to check PR state")
	}
	const token = requireEnv("CLOUDFLARE_API_TOKEN")
	const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID")

	// One PR-state lookup per PR number, shared across both passes — a stage
	// leaks ~8 workers + 2 queues and they all share the same verdict.
	const stateByPr = new Map<string, "open" | "closed" | "unknown">()
	const prState = async (prNumber: string): Promise<"open" | "closed" | "unknown"> => {
		let state = stateByPr.get(prNumber)
		if (!state) {
			state = await fetchPrState(prNumber)
			stateByPr.set(prNumber, state)
		}
		return state
	}
	const failures: string[] = []

	// Pass 1: detach consumer registrations from closed-PR queues, so the
	// worker deletions in pass 2 stop failing with 10064. The queues
	// themselves are deleted in pass 3, after the workers' producer bindings
	// are gone (deleting them here fails with 11005).
	const listedQueues = await cfRequest(token, `/accounts/${accountId}/queues?per_page=100`)
	if (!listedQueues.ok) {
		fail(
			`Could not list Queues (HTTP ${listedQueues.status}): ${JSON.stringify(listedQueues.errors)}`,
		)
	}
	// A success response whose `result` isn't an array means the API shape
	// changed under us — fail loudly rather than green-no-op'ing the safety net.
	if (!Array.isArray(listedQueues.result)) {
		fail(
			`Unexpected Queue list response shape (result is ${typeof listedQueues.result}, expected array)`,
		)
	}
	const queues = listedQueues.result as ReadonlyArray<QueueInfo>
	const queueCandidates = queues
		.map((queue) => ({
			id: queue.queue_id ?? "",
			name: queue.queue_name ?? "",
			match: PR_RESOURCE_PATTERN.exec(queue.queue_name ?? ""),
		}))
		.filter(
			(entry): entry is { id: string; name: string; match: RegExpExecArray } =>
				entry.match !== null && entry.id.length > 0,
		)
	console.log(
		`Found ${queues.length} Queue(s), ${queueCandidates.length} maple-*-pr-*: ${queueCandidates.map((c) => c.name).join(", ") || "—"}`,
	)
	const queuesToDelete: Array<{ id: string; name: string }> = []
	for (const { id, name, match } of queueCandidates) {
		const prNumber = match[2] as string
		const state = await prState(prNumber)
		if (state === "open") {
			console.log(`… keeping ${name} (PR #${prNumber} is open)`)
			continue
		}
		if (state === "unknown") {
			console.log(`⚠ skipping ${name} (PR #${prNumber} state unknown)`)
			continue
		}
		queuesToDelete.push({ id, name })
		const consumers = await cfRequest(token, `/accounts/${accountId}/queues/${id}/consumers`)
		if (!consumers.ok || !Array.isArray(consumers.result)) {
			console.log(
				`✗ could not list consumers of ${name} (HTTP ${consumers.status}): ${JSON.stringify(consumers.errors)}`,
			)
			failures.push(name)
			continue
		}
		for (const consumer of consumers.result as ReadonlyArray<QueueConsumer>) {
			// Newer API rows carry consumer_id; older ones are addressed by the
			// consuming script's name. Try whichever this row has.
			const consumerRef = consumer.consumer_id ?? consumer.id ?? consumer.script ?? consumer.script_name
			if (!consumerRef) {
				console.log(`✗ consumer of ${name} has no usable id: ${JSON.stringify(consumer)}`)
				failures.push(name)
				continue
			}
			console.log(`… detaching consumer ${consumerRef} from ${name} (PR #${prNumber} is closed)`)
			const detached = await cfRequest(
				token,
				`/accounts/${accountId}/queues/${id}/consumers/${consumerRef}`,
				{ method: "DELETE" },
			)
			if (!detached.ok && detached.status !== 404) {
				console.log(`✗ detach failed (HTTP ${detached.status}): ${JSON.stringify(detached.errors)}`)
				failures.push(name)
			}
		}
	}

	// Pass 2: workers.
	const listed = await cfRequest(token, `/accounts/${accountId}/workers/scripts`)
	if (!listed.ok) {
		fail(`Could not list Worker scripts (HTTP ${listed.status}): ${JSON.stringify(listed.errors)}`)
	}
	if (!Array.isArray(listed.result)) {
		fail(`Unexpected Worker list response shape (result is ${typeof listed.result}, expected array)`)
	}
	const scripts = listed.result as ReadonlyArray<WorkerScript>
	const candidates = scripts
		.map((script) => ({
			name: script.id ?? "",
			match: PR_RESOURCE_PATTERN.exec(script.id ?? ""),
		}))
		.filter(
			(entry): entry is { name: string; match: RegExpExecArray } =>
				entry.match !== null && entry.name.length > 0,
		)
	console.log(
		`Found ${scripts.length} Worker script(s), ${candidates.length} maple-*-pr-*: ${candidates.map((c) => c.name).join(", ") || "—"}`,
	)
	for (const { name, match } of candidates) {
		const prNumber = match[2] as string
		const state = await prState(prNumber)
		if (state === "open") {
			console.log(`… keeping ${name} (PR #${prNumber} is open)`)
			continue
		}
		if (state === "unknown") {
			console.log(`⚠ skipping ${name} (PR #${prNumber} state unknown)`)
			continue
		}
		console.log(`… deleting orphan ${name} (PR #${prNumber} is closed)`)
		const removed = await cfRequest(
			token,
			`/accounts/${accountId}/workers/scripts/${name}?force=true`,
			{ method: "DELETE" },
		)
		if (!removed.ok && removed.status !== 404) {
			console.log(`✗ delete failed (HTTP ${removed.status}): ${JSON.stringify(removed.errors)}`)
			failures.push(name)
		}
	}

	// Pass 3: the queues themselves — only now that no worker binds them.
	for (const { id, name } of queuesToDelete) {
		console.log(`… deleting orphan queue ${name}`)
		const removed = await cfRequest(token, `/accounts/${accountId}/queues/${id}`, {
			method: "DELETE",
		})
		if (!removed.ok && removed.status !== 404) {
			console.log(`✗ delete failed (HTTP ${removed.status}): ${JSON.stringify(removed.errors)}`)
			failures.push(name)
		}
	}

	if (failures.length > 0) {
		fail(`Failed to sweep orphan Queue(s)/Worker(s): ${failures.join(", ")}`)
	}
	console.log("✓ Sweep complete")
}

await main()
