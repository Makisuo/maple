import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core"

export const digestSubscriptions = sqliteTable(
	"digest_subscriptions",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").notNull(),
		userId: text("user_id").notNull(),
		email: text("email").notNull(),
		enabled: integer("enabled", { mode: "number" }).notNull().default(1),
		dayOfWeek: integer("day_of_week", { mode: "number" }).notNull().default(1),
		timezone: text("timezone").notNull().default("UTC"),
		lastSentAt: integer("last_sent_at", { mode: "number" }),
		createdAt: integer("created_at", { mode: "number" }).notNull(),
		updatedAt: integer("updated_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("digest_subscriptions_org_user_idx").on(
			table.orgId,
			table.userId,
		),
		index("digest_subscriptions_org_enabled_idx").on(
			table.orgId,
			table.enabled,
		),
	],
)

export type DigestSubscriptionRow = typeof digestSubscriptions.$inferSelect
