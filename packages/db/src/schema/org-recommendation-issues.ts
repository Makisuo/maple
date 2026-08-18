import type { OrgId } from "@maple/domain"
import { index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"

// Durable, numbered attribute-recommendation issues (PlanetScale-style). Recommendations are
// detected from live telemetry on each reconcile and upserted here, so each gets a stable per-org
// number, an opened-at timestamp, and a lifecycle status that survives across sessions/devices.
//
// status:
//   open      — detected and not acted on
//   dismissed — user dismissed it (reopenable)
//   applied   — user created the mapping; the key is no longer detected
//   resolved  — no longer detected (fixed at the SDK), and no mapping covers it
export const orgRecommendationIssues = pgTable(
	"org_recommendation_issues",
	{
		id: text("id").notNull().primaryKey(),
		orgId: text("org_id").$type<OrgId>().notNull(),
		/** Per-org monotonic display number (`#1`, `#2`, …). */
		number: integer("number").notNull(),
		/** Stable dedupe key from the detector, e.g. `rename:http.status_code`. */
		recommendationKey: text("recommendation_key").notNull(),
		kind: text("kind").notNull(),
		sourceKey: text("source_key").notNull(),
		canonicalKey: text("canonical_key"),
		status: text("status").notNull().default("open"),
		usageCount: integer("usage_count").notNull().default(0),
		openedAt: timestamp("opened_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
		resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
	},
	(table) => [
		index("org_recommendation_issues_org_idx").on(table.orgId),
		uniqueIndex("org_recommendation_issues_org_key_idx").on(table.orgId, table.recommendationKey),
	],
)

export type OrgRecommendationIssueRow = typeof orgRecommendationIssues.$inferSelect
export type OrgRecommendationIssueInsert = typeof orgRecommendationIssues.$inferInsert
