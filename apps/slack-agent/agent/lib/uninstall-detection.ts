import { notifyMapleRevocation } from "./maple.js"

/**
 * Detects Slack's `app_uninstalled` / `tokens_revoked` events inside the
 * verified webhook body and forwards them to Maple's API, so a Slack-side
 * uninstall (or token revoke) drops the org's binding immediately instead of
 * waiting on Maple's reconciliation cron.
 *
 * eve only dispatches `app_mention` + DM events downstream, so these two
 * event types would otherwise be silently dropped as `unsupported` — same
 * situation `thread-follow-up.ts` works around, and the same fix: our custom
 * `webhookVerifier` sees every verified body before eve's parser does, so
 * this hooks in there rather than patching eve.
 */

export interface UninstallDetectionDeps {
	notifyMapleRevocation(teamId: string, reason: "app_uninstalled" | "tokens_revoked"): Promise<void>
}

const defaultDeps: UninstallDetectionDeps = { notifyMapleRevocation }

export interface RevocationEvent {
	readonly teamId: string
	readonly reason: "app_uninstalled" | "tokens_revoked"
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Parses a verified inbound Slack webhook body for `app_uninstalled` /
 * `tokens_revoked`. Never throws on malformed input — anything unexpected
 * simply doesn't qualify.
 */
export function parseRevocationEvent(rawBody: string): RevocationEvent | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(rawBody)
	} catch {
		return null
	}
	if (!isRecord(parsed) || parsed.type !== "event_callback") return null

	const event = parsed.event
	if (!isRecord(event)) return null
	const eventType = event.type
	if (eventType !== "app_uninstalled" && eventType !== "tokens_revoked") return null

	const teamId = parsed.team_id
	if (typeof teamId !== "string" || teamId.length === 0) return null

	return { teamId, reason: eventType }
}

/**
 * Inspects a verified inbound Slack webhook body and, if it is an
 * `app_uninstalled` / `tokens_revoked` event, forwards it to Maple. Intended
 * to be fired without awaiting from the webhook handler — it must never delay
 * or fail the webhook ack — so it never throws: `notifyMapleRevocation`
 * failures are caught and passed to `onError` (default: `console.warn`)
 * rather than rejecting. A dropped forward is silently backstopped by
 * Maple's reconciliation cron.
 */
export async function forwardUninstallEvent(
	rawBody: string,
	deps: UninstallDetectionDeps = defaultDeps,
	onError: (error: unknown, event: RevocationEvent) => void = (error, event) =>
		console.warn(
			`[slack-webhook] Failed to forward ${event.reason} for team ${event.teamId} to Maple`,
			error,
		),
): Promise<void> {
	const event = parseRevocationEvent(rawBody)
	if (!event) return
	try {
		await deps.notifyMapleRevocation(event.teamId, event.reason)
	} catch (error) {
		onError(error, event)
	}
}
