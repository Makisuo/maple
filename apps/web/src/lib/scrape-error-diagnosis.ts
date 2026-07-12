import type { ScrapeTargetType } from "@maple/domain/primitives"

/**
 * A human-readable diagnosis of a scrape failure. The scraper records raw error
 * strings (`target returned HTTP 429`, discovery messages, timeouts); this turns
 * them into something a user can act on, tailored to PlanetScale targets.
 */
export interface ScrapeErrorDiagnosis {
	/** Drives the Alert variant — warning for transient/rate issues, error otherwise. */
	readonly severity: "warning" | "error"
	/** Short headline, e.g. "Rate limited by PlanetScale". */
	readonly title: string
	/** One-sentence explanation of what went wrong. */
	readonly summary: string
	/** Ordered, concrete remediation steps. */
	readonly fixes: ReadonlyArray<string>
}

/** Strip the `[branch:<x>] ` prefix the API adds to PlanetScale rollup errors. */
const stripBranchPrefix = (message: string): string =>
	message.replace(/^\[branch:[^\]]*\]\s*/, "")

const httpStatusOf = (message: string): number | null => {
	const match = message.match(/HTTP (\d{3})/)
	return match ? Number(match[1]) : null
}

const isPlanetScale = (targetType: ScrapeTargetType): boolean => targetType === "planetscale"

/**
 * Translate a recorded scrape/discovery error into an actionable diagnosis.
 * Returns `null` when the message is empty (nothing to diagnose).
 */
export const diagnoseScrapeError = (
	rawMessage: string | null | undefined,
	targetType: ScrapeTargetType,
): ScrapeErrorDiagnosis | null => {
	if (!rawMessage) return null
	const message = stripBranchPrefix(rawMessage.trim())
	if (message.length === 0) return null

	const planetScale = isPlanetScale(targetType)
	const isDiscovery = /discovery/i.test(message)
	const status = httpStatusOf(message)

	// Timeouts / connectivity (no HTTP status reached).
	if (/timed out|operation was aborted|ETIMEDOUT/i.test(message)) {
		return {
			severity: "error",
			title: "Request timed out",
			summary: planetScale
				? "PlanetScale did not respond before Maple's scrape timeout."
				: "The target did not respond before Maple's scrape timeout.",
			fixes: [
				"Confirm the endpoint is reachable and responding within ~10s.",
				"If responses are consistently slow, raise the scrape interval to give each request more time.",
			],
		}
	}

	if (status === 429) {
		return {
			severity: "warning",
			title: "Rate limited",
			summary: planetScale
				? "PlanetScale's metrics API rejected the request with HTTP 429 (too many requests)."
				: "The target rejected the request with HTTP 429 (too many requests).",
			fixes: planetScale
				? [
						"Raise the scrape interval (e.g. to 60s or more) so Maple polls PlanetScale less often.",
						"Each database branch is scraped as a separate target — many branches multiply request volume against PlanetScale's rate limit.",
						"Maple now backs off automatically after a 429, but a longer interval is the durable fix.",
					]
				: [
						"Raise the scrape interval so Maple polls the target less often.",
						"Maple backs off automatically after a 429, but a longer interval is the durable fix.",
					],
		}
	}

	if (status === 401 || status === 403) {
		return {
			severity: "error",
			title: "Authentication rejected",
			summary: planetScale
				? `PlanetScale rejected the credentials (HTTP ${status}).`
				: `The target rejected the credentials (HTTP ${status}).`,
			fixes: planetScale
				? [
						"For the managed integration target, reconnect PlanetScale from the Integrations page to refresh the authorization.",
						"Confirm the authorization (OAuth app scope or service token) has the read_metrics_endpoints permission.",
						"For a manual service-token target, re-create the token in PlanetScale if it was revoked or rotated, then update it here.",
					]
				: [
						"Check the auth type and credentials configured for this target.",
						"Confirm the token/password is still valid and has access to the metrics endpoint.",
					],
		}
	}

	if (status === 404) {
		return {
			severity: "error",
			title: "Endpoint not found",
			summary: planetScale
				? "PlanetScale returned HTTP 404 for the metrics endpoint."
				: "The target returned HTTP 404 for the metrics endpoint.",
			fixes: planetScale
				? [
						"Verify the organization name is correct.",
						"Confirm metrics are enabled for this PlanetScale organization.",
					]
				: ["Verify the metrics URL path is correct and currently served by the target."],
		}
	}

	if (status !== null && status >= 500) {
		return {
			severity: "warning",
			title: planetScale ? "PlanetScale-side error" : "Upstream error",
			summary: `The target returned HTTP ${status} — this is usually transient.`,
			fixes: [
				"This is typically a temporary upstream problem; Maple will keep retrying.",
				planetScale
					? "If it persists, check PlanetScale's status page."
					: "If it persists, check the target service's health.",
			],
		}
	}

	// Discovery-stage failures that didn't carry a recognized status.
	if (isDiscovery) {
		return {
			severity: "error",
			title: "Discovery failed",
			summary: planetScale
				? "Maple could not discover PlanetScale database branches to scrape."
				: "Maple could not discover targets to scrape.",
			fixes: planetScale
				? [
						"Check the service-token id/secret and its read_metrics_endpoints permission.",
						"Verify the organization name and that metrics are enabled.",
					]
				: ["Verify the discovery endpoint and credentials."],
		}
	}

	// Anything else — surface the raw message so it isn't lost.
	return {
		severity: "error",
		title: "Scrape failed",
		summary: message,
		fixes: [
			"Use the Test button to re-run the scrape and see the latest error.",
			"Check the target URL, credentials, and that it exposes Prometheus-format metrics.",
		],
	}
}
