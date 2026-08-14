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
}

export interface DispatchResult {
	readonly providerMessage: string
	readonly providerReference: string | null
	readonly responseCode: number | null
}
