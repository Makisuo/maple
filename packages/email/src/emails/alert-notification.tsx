import { AlertNotification } from "../alert-notification"

/** react-email preview entry — critical trigger. */
export default function AlertNotificationPreview() {
	return AlertNotification({
		ruleName: "API error rate — checkout",
		eventLabel: "Triggered",
		eventEmoji: "\u{1F6A8}",
		severity: "critical",
		signalLabel: "Error Rate",
		group: "checkout-service",
		observedSummary: "5.2% > 1%",
		window: "5m",
		accentColor: "#e01e5a",
		linkUrl: "https://app.maple.dev/alerts/rule_123",
		chatUrl: "https://app.maple.dev/alerts/incidents/inc_456",
	})
}
