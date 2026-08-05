// Setup progression for the PlanetScale integration.
//
// Connecting PlanetScale is genuinely two-part and the UI used to hide that. The
// OAuth grant covers the management plane (inventory, query insights, webhooks),
// but PlanetScale's metrics data plane only accepts service tokens — so the
// bearer probe almost always fails and a freshly-connected org sits at
// `metricsAuth: "missing"` with a paused scrape target. Presenting that as a
// warning badge on an otherwise "Connected" card taught people the integration
// was broken. Presenting it as step 3 of 4 teaches them it isn't finished.
//
// Pure — no React, no atoms — so the progression rules are testable on their own
// (same shape as branch-selection.ts).

import type { V2PlanetScaleIntegration, V2PlanetScaleScrapeTarget } from "@maple/domain/http/v2"

export type MetricsAuth = "oauth" | "service_token" | "missing"

/**
 * Outcome-level health of the managed branch-metrics scrape. One machine, shared
 * by the status row and the setup checklist, so the two can never disagree about
 * whether metrics are flowing.
 *
 * `unconfigured` is distinct from `waiting`: nothing has been *asked* to scrape
 * yet, versus a scrape that was asked for and hasn't landed.
 */
export type MetricsHealthState = "unconfigured" | "waiting" | "healthy" | "stalled" | "degraded"

export function metricsHealthState(
	target: V2PlanetScaleScrapeTarget | null,
	metricsAuth: MetricsAuth,
	nowMs: number,
): MetricsHealthState {
	if (metricsAuth === "missing" || target === null) return "unconfigured"
	if (target.last_scrape_error !== null) return "degraded"
	if (target.last_scrape_at === null) return "waiting"
	// Three intervals of silence: one missed scrape is jitter, three is a fault.
	const lastScrapeMs = Date.parse(target.last_scrape_at)
	if (nowMs - lastScrapeMs > 3 * target.scrape_interval_seconds * 1000) return "stalled"
	return "healthy"
}

/**
 * No branch metric has ever been collected for this connection — as opposed to
 * "collection broke", which still has history worth rendering.
 *
 * The infra pages branch on this: never-collected shows the setup card, because
 * a stat rail and a table of dashes over a connection that was never asked to
 * scrape reads as a broken product rather than an unfinished setup. Once one
 * scrape has landed the pages render normally forever after, and degradation is
 * carried by the inline notices instead.
 */
export const metricsNeverCollected = (status: V2PlanetScaleIntegration): boolean =>
	status.metrics_auth === "missing" ||
	status.scrape_target === null ||
	status.scrape_target.last_scrape_at === null

export type SetupStepId = "connected" | "permissions" | "metrics-token" | "first-metrics"

/**
 * `blocked` is not `pending`: something is wrong and the operator has to act.
 * `current` is the one step the card expands.
 */
export type SetupStepState = "done" | "current" | "blocked" | "pending"

export interface SetupStep {
	readonly id: SetupStepId
	readonly title: string
	readonly state: SetupStepState
	/** One line: what happened, or what to do next. Rendered under the title. */
	readonly detail: string
	/**
	 * The step is `current` because Maple is working, not because the operator
	 * is. Drives whether the marker spins — a spinner next to a step that is
	 * waiting on a paste reads as "don't touch this", which is the opposite of
	 * what it means.
	 */
	readonly waitingOnMaple: boolean
}

export interface PlanetScaleSetup {
	readonly steps: ReadonlyArray<SetupStep>
	/** Every step done — the card collapses to its quiet connected form. */
	readonly complete: boolean
	/**
	 * A token exists and the first scrape hasn't landed. The card polls status
	 * while this is true so "waiting" resolves to "streaming" without a reload.
	 */
	readonly awaitingFirstScrape: boolean
	readonly health: MetricsHealthState
	/** 1-based index of the `current`/`blocked` step, or null once complete. */
	readonly activeStepNumber: number | null
}

/**
 * Derive the four-step progression from the status the card already fetches.
 * Everything here is a function of `status` — no extra requests, no local state.
 */
export function derivePlanetScaleSetup(status: V2PlanetScaleIntegration, nowMs: number): PlanetScaleSetup {
	const target = status.scrape_target
	const health = metricsHealthState(target, status.metrics_auth, nowMs)
	const revoked = status.revoked_at !== null
	// `detected_permissions` is null before the org is bound; absent is unknown,
	// not denied — only an explicit `false` blocks.
	const readDatabasesDenied = status.detected_permissions?.readDatabases === false
	const hasToken = status.metrics_auth !== "missing"

	const step = (
		id: SetupStepId,
		title: string,
		state: SetupStepState,
		detail: string,
		waitingOnMaple = false,
	): SetupStep => ({ id, title, state, detail, waitingOnMaple })

	const connected = revoked
		? step(
				"connected",
				"Authorization",
				"blocked",
				"The PlanetScale authorization was revoked — reconnect to resume collection.",
			)
		: step(
				"connected",
				"Authorization",
				"done",
				status.organization !== null
					? `Connected to ${status.organization}`
					: "OAuth authorization stored",
			)

	const permissions = revoked
		? step("permissions", "Permissions", "pending", "Checked once the authorization is restored.")
		: readDatabasesDenied
			? step(
					"permissions",
					"Permissions",
					"blocked",
					"The authorization can't read databases — grant the read_databases scope, then reconnect.",
				)
			: step("permissions", "Permissions", "done", "Inventory, query insights, and webhooks are live.")

	// The token step is only *current* once the two above are settled, so the
	// card never asks for a token while the grant itself is broken.
	const upstreamBlocked = revoked || readDatabasesDenied
	const metricsToken = hasToken
		? step(
				"metrics-token",
				"Branch metrics access",
				"done",
				status.metrics_auth === "oauth"
					? "The authorization covers the metrics endpoints — no token needed."
					: "Authenticated with a service token.",
			)
		: step(
				"metrics-token",
				"Branch metrics access",
				upstreamBlocked ? "pending" : "current",
				"PlanetScale only serves branch metrics to service tokens. Add one to finish.",
			)

	const firstMetrics = ((): SetupStep => {
		const title = "Metrics arriving"
		if (!hasToken) {
			return step(
				"first-metrics",
				title,
				"pending",
				"Starts automatically once branch metrics access is set up.",
			)
		}
		switch (health) {
			case "healthy":
				return step("first-metrics", title, "done", "Streaming branch metrics.")
			case "degraded":
				return step("first-metrics", title, "blocked", "The last scrape failed.")
			case "stalled":
				return step(
					"first-metrics",
					title,
					"blocked",
					"Metrics stopped arriving — collection has stalled.",
				)
			default:
				// The only step where nothing is asked of the operator: Maple is
				// scraping and the first sample hasn't landed.
				return step("first-metrics", title, "current", "Waiting for the first scrape.", true)
		}
	})()

	const steps = [connected, permissions, metricsToken, firstMetrics]
	const activeIndex = steps.findIndex((step) => step.state === "current" || step.state === "blocked")

	return {
		steps,
		complete: activeIndex === -1,
		awaitingFirstScrape: hasToken && (health === "waiting" || health === "unconfigured"),
		health,
		activeStepNumber: activeIndex === -1 ? null : activeIndex + 1,
	}
}
