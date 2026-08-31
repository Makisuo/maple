import type { OrgId } from "@maple/domain"
import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

export const digestSubscriptions = pgTable(
	"digest_subscriptions",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		userId: text("user_id").notNull(),
		email: text("email").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		dayOfWeek: integer("day_of_week").notNull().default(1),
		timezone: text("timezone").notNull().default("UTC"),
		/**
		 * JSON-encoded string arrays scoping the digest to a slice of the org.
		 * Empty array = every namespace / environment, which is the default and
		 * what every pre-existing row carries. Same shape as
		 * `alert_rules.environments_json`.
		 */
		namespacesJson: text("namespaces_json").notNull().default("[]"),
		environmentsJson: text("environments_json").notNull().default("[]"),
		lastSentAt: timestamp("last_sent_at", { withTimezone: true, mode: "date" }),
		lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [
		uniqueIndex("digest_subscriptions_org_user_idx").on(table.orgId, table.userId),
		index("digest_subscriptions_org_enabled_idx").on(table.orgId, table.enabled),
	],
)

export type DigestSubscriptionRow = typeof digestSubscriptions.$inferSelect
