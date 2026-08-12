import { AlertDeliveryError } from "@maple/domain/http"
import { Effect } from "effect"
import {
	eventTypeEmoji,
	formatEventTypeLabel,
	formatObservedSummary,
	formatSignalLabel,
	formatWindow,
	slackAttachmentColor,
	type TemplateRenderContext,
} from "./alert-formatting"

export interface AlertEmailContent {
	readonly subject: string
	readonly html: string
}

/**
 * Render the alert notification email from the same pre-formatted values the
 * Slack/Discord payload builders use, so channels never drift. Custom
 * notification templates are not consulted for email — HTML email can't safely
 * render arbitrary user Markdown, so email always uses the built-in format.
 */
export const buildAlertEmailContent = (
	context: TemplateRenderContext,
	linkUrl: string,
	chatUrl: string,
): Effect.Effect<AlertEmailContent, AlertDeliveryError> =>
	Effect.tryPromise({
		try: async () => {
			// Dynamically imported so @react-email (tailwind/prettier/prism, ~2MB of
			// module eval) stays out of the request-path module graph — it loads only
			// when an email alert actually fires.
			const [{ render }, { AlertNotification }] = await Promise.all([
				import("@react-email/components"),
				import("@maple/email/alert-notification"),
			])
			const eventLabel = formatEventTypeLabel(context.eventType)
			const emoji = eventTypeEmoji(context.eventType)
			const html = await render(
				AlertNotification({
					ruleName: context.ruleName,
					eventLabel,
					eventEmoji: emoji,
					severity: context.severity,
					signalLabel: formatSignalLabel(context.signalType),
					group: context.groupKey ?? "all",
					observedSummary: formatObservedSummary(context),
					window: formatWindow(context.windowMinutes),
					accentColor: slackAttachmentColor(context.eventType, context.severity),
					linkUrl,
					chatUrl,
				}),
			)
			return {
				subject: `${emoji} ${context.ruleName} — ${eventLabel}`,
				html,
			}
		},
		catch: (error) =>
			new AlertDeliveryError({
				message:
					error instanceof Error
						? `Failed to render alert email: ${error.message}`
						: "Failed to render alert email",
				destinationType: "email",
			}),
	})
