import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import type { OrgId } from "@maple/domain/primitives"

/**
 * A Live Activity running on someone's Lock Screen for one alert incident.
 *
 * The server starts these with the device's push-to-start token (on
 * `mobile_devices`), but every subsequent update has to go to a token that only
 * exists once the activity is running and that ActivityKit hands to the *app* —
 * so the app POSTs it back and it is stored here. One row per (device,
 * incident): the same incident on two phones is two activities with two tokens.
 *
 * Rows are kept after the activity ends so a late renotify does not resurrect a
 * dismissed activity, and so "why did my phone not show it" is answerable.
 */
export const liveActivities = pgTable(
	"live_activities",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		/** `mobile_devices.id`. Not a FK: the device row can be deleted on sign-out. */
		deviceId: text("device_id").notNull(),
		/** Internal alert-incident id — the same one `alert_incidents.id` carries. */
		incidentId: text("incident_id").notNull(),
		/** ActivityKit's own id for the activity, for logs and for the app's own bookkeeping. */
		activityId: text("activity_id").notNull(),
		/** The per-activity APNs update token, hex. Rotates; the app re-POSTs it. */
		pushToken: text("push_token").notNull(),
		/** Set when the activity was ended — by a resolve, by the user, or by APNs rejecting the token. */
		endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
		endedReason: text("ended_reason"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("live_activities_device_incident_unique").on(table.deviceId, table.incidentId),
		index("live_activities_incident_idx").on(table.orgId, table.incidentId),
	],
)

export type LiveActivityRow = typeof liveActivities.$inferSelect
