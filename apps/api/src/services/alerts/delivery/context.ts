/**
 * The dispatch value types, extracted from `AlertDeliveryDispatch` so the
 * transports can depend on them without importing the module that composes the
 * transports (a runtime import cycle).
 *
 * `DispatchContext` is still the pre-refactor 22-field flat shape; collapsing
 * it and its five near-duplicates onto one canonical notification is a later
 * stage. It is moved here unchanged so that stage is a rename, not a move.
 */
import type { AlertComparator, AlertEventType, AlertSeverity, AlertSignalType } from "@maple/domain/http"
import type { AlertDestinationRow } from "@maple/db"
import type { EnrichedDestinationSecretConfig } from "../AlertDestinationHydration"
import type { SignalDisplay } from "../alert-signal-display"
import type { NotificationTemplateConfig } from "../alert-templating/renderer"

interface DestinationPublicConfig {
	readonly summary: string
	readonly channelLabel: string | null
}

export interface DispatchContext {
	readonly deliveryKey: string
	readonly destination: AlertDestinationRow
	readonly publicConfig: DestinationPublicConfig
	readonly secretConfig: EnrichedDestinationSecretConfig
	readonly ruleId: string
	readonly ruleName: string
	readonly groupKey: string | null
	readonly signalType: AlertSignalType
	/**
	 * How this rule's measured quantity is named and unit-formatted. Resolved
	 * from the rule at dispatch time, because `signalType` alone is the query
	 * kind and cannot name what a `builder_query`/`raw_query` rule measures.
	 * Optional: the escalation/error paths dispatch without an alert rule.
	 */
	readonly signalDisplay?: SignalDisplay | null
	readonly severity: AlertSeverity
	readonly comparator: AlertComparator
	readonly threshold: number
	readonly thresholdUpper: number | null
	readonly eventType: AlertEventType
	readonly incidentId: string | null
	readonly incidentStatus: string
	readonly dedupeKey: string
	readonly windowMinutes: number
	readonly value: number | null
	readonly sampleCount: number | null
	/**
	 * User-customized notification template (title + Markdown body, optional
	 * per-destination overrides). `null`/absent → the built-in hardcoded format.
	 * Snapshotted at enqueue time so retries and post-fire edits stay stable.
	 */
	readonly template?: NotificationTemplateConfig | null
	/** Epoch ms the notification was sent — exposed to templates as `sentAt`. */
	readonly sentAtMs?: number
	/**
	 * Unicode sparkline of the rule's recent observed values, or absent when
	 * the series was unavailable or too short to be worth drawing.
	 *
	 * Text rather than an image because this has to survive where images do not
	 * — a phone's lock screen, a push preview, a plain-text email client. It is
	 * snapshotted at queue time so a retry shows what the alert saw, not what
	 * the metric has done since.
	 */
	readonly sparkline?: string | null
	/**
	 * Public URL of this notification's chart image, or absent when there was no
	 * series to draw or the deployment has no share HMAC key.
	 *
	 * Signed and window-pinned (see `alertChartId`), so it renders the same
	 * picture forever. Providers that can show an image use it; the sparkline
	 * stays regardless, because an image block does not reach a lock screen.
	 */
	readonly chartUrl?: string | null
}

export interface DispatchResult {
	readonly providerMessage: string
	readonly providerReference: string | null
	readonly responseCode: number | null
}
