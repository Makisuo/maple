import type { OrgId } from "@maple/domain"
import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const orgIngestAttributeMappings = pgTable(
	"org_ingest_attribute_mappings",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		name: text("name").notNull(),
		sourceContext: text("source_context").notNull(),
		sourceKey: text("source_key").notNull(),
		targetKey: text("target_key").notNull(),
		operation: text("operation").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
	},
	(table) => [index("org_ingest_attribute_mappings_org_idx").on(table.orgId)],
)

export type OrgIngestAttributeMappingRow = typeof orgIngestAttributeMappings.$inferSelect
export type OrgIngestAttributeMappingInsert = typeof orgIngestAttributeMappings.$inferInsert
