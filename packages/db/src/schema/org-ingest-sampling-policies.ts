import type { OrgId } from "@maple/domain"
import { boolean, doublePrecision, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const orgIngestSamplingPolicies = pgTable("org_ingest_sampling_policies", {
	orgId: text("org_id").$type<OrgId>().primaryKey().notNull(),
	traceSampleRatio: doublePrecision("trace_sample_ratio").notNull().default(1),
	alwaysKeepErrorSpans: boolean("always_keep_error_spans").notNull().default(true),
	alwaysKeepSlowSpansMs: integer("always_keep_slow_spans_ms"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
})
