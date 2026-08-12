/**
 * Runtime renderer for the alert notification email.
 *
 * The markup lives in `emails/alert-notification.html` and is compiled to
 * `src/generated/alert-notification.ts` by Maizzle (`bun run --cwd
 * packages/email build`). This module only splices those strings together.
 */
import { FRAGMENTS, PAGE } from "./generated/alert-notification"
import { escapeHtml, fill, preheaderPadding, truncate } from "./template"

/**
 * All values are pre-formatted strings — the api layer formats via the same
 * helpers the Slack/Discord payload builders use, so channels never drift.
 */
export interface AlertNotificationProps {
	ruleName: string
	/** Human event label, e.g. "Triggered" / "Resolved" / "Test". */
	eventLabel: string
	/** Event emoji, e.g. 🚨 / ✅ / 🧪. */
	eventEmoji: string
	severity: string
	signalLabel: string
	/** Group key, or "all". */
	group: string
	/** Observed value + comparison, e.g. "5.2% > 1%". */
	observedSummary: string
	/** Evaluation window, e.g. "5m". */
	window: string
	/** Hex accent color for the event/severity, e.g. "#e01e5a". */
	accentColor: string
	/** Deep link to the alert in Maple. */
	linkUrl: string
	/** Deep link to Maple AI for this alert. */
	chatUrl: string
}

const FG = "#e8dfd3"

export function renderAlertNotification(props: AlertNotificationProps): string {
	const {
		ruleName,
		eventLabel,
		eventEmoji,
		severity,
		signalLabel,
		group,
		observedSummary,
		window,
		accentColor,
		linkUrl,
		chatUrl,
	} = props

	const previewText = `${eventLabel}: ${ruleName} — ${observedSummary}`

	const detailRows = [
		{ label: "Severity", value: severity, valueColor: accentColor },
		{ label: "Signal", value: signalLabel, valueColor: FG },
		{ label: "Group", value: group, valueColor: FG },
		{ label: "Observed", value: observedSummary, valueColor: FG },
		{ label: "Window", value: window, valueColor: FG },
	]
		.map((row) => fill(FRAGMENTS.detailRow, row))
		.join("\n")

	return fill(
		PAGE,
		{
			previewText,
			accentColor,
			eventLabel,
			eventEmoji,
			ruleName: truncate(ruleName, 80),
			observedSummary,
			linkUrl,
			chatUrl,
		},
		{ preheaderPad: escapeHtml(preheaderPadding(previewText)), detailRows },
	)
}
