import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import type { OrgId, UserId } from "@maple/domain/primitives"

/**
 * Which alert events a device wants. Absent keys read as their default in
 * `packages/domain/src/http/mobile-devices.ts` — a device registered by an
 * older app build keeps getting the notifications the newer build added.
 */
export interface MobileDevicePreferences {
	readonly criticalIncidents?: boolean
	readonly warningIncidents?: boolean
	readonly resolvedIncidents?: boolean
	readonly newErrorIssues?: boolean
	readonly anomalies?: boolean
}

/**
 * A phone that wants push notifications for an organization.
 *
 * Push is **user-scoped**, not an alert destination: destinations are the
 * org's Slack channels and pagers, configured by admins and attached to
 * rules. A phone belongs to a person, follows them across orgs, and is
 * registered by the app itself. So it lives here rather than in
 * `alert_destinations`, and the fan-out reads this table directly instead of
 * going through a rule's `destination_ids`.
 *
 * One row per (org, platform, token): the same phone signed into two orgs is
 * two rows with independent preferences.
 */
export const mobileDevices = pgTable(
	"mobile_devices",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		userId: text("user_id").$type<UserId>().notNull(),
		platform: text("platform").notNull(),
		/** The APNs device token, hex. */
		token: text("token").notNull(),
		/** `sandbox` (Xcode/TestFlight-development builds) or `production`. Decides the APNs host. */
		environment: text("environment").notNull(),
		bundleId: text("bundle_id").notNull(),
		appVersion: text("app_version"),
		deviceName: text("device_name"),
		preferences: jsonb("preferences").$type<MobileDevicePreferences>().notNull(),
		/** Set when APNs reports the token dead (410 / BadDeviceToken); the row is kept for the audit trail. */
		disabledAt: timestamp("disabled_at", { withTimezone: true, mode: "date" }),
		disabledReason: text("disabled_reason"),
		lastPushedAt: timestamp("last_pushed_at", { withTimezone: true, mode: "date" }),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("mobile_devices_org_platform_token_unique").on(table.orgId, table.platform, table.token),
		index("mobile_devices_org_idx").on(table.orgId),
		index("mobile_devices_user_idx").on(table.userId),
	],
)

export type MobileDeviceRow = typeof mobileDevices.$inferSelect
