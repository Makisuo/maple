/**
 * Product events for the dashboard, recorded through Maple's own SDK.
 *
 * `track()` lands as a `session_events` row with `Type='custom'`, so an
 * activation milestone shows up inline in the session transcript next to the
 * clicks and network calls around it — not in a separate analytics silo. The
 * session already carries the Clerk user and org (see `clerk-auth-bridge.tsx`)
 * and a visitor id shared with `maple.dev`, so these events join back to the
 * marketing visit that produced the signup.
 *
 * Names are `object_action` and live in the union below: the warehouse column is
 * a free-form String, so nothing downstream would catch `dashboard_created` and
 * `created_dashboard` both existing.
 */

import { track, type TrackProps } from "@maple-dev/effect-sdk/client"

export type ProductEvent =
	| "onboarding_step_completed"
	| "integration_connected"
	| "alert_rule_created"
	| "api_key_created"
	| "dashboard_created"
	| "chat_message_sent"

/**
 * Record a product event. Never throws and never awaits — the SDK buffers and
 * flushes on its own, so call sites can fire this next to a toast.
 */
export function trackProduct(event: ProductEvent, props?: TrackProps): void {
	track(event, props)
}
