import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"

export const orgIngestSamplingPolicies = sqliteTable("org_ingest_sampling_policies", {
	orgId: text("org_id").primaryKey().notNull(),
	traceSampleRatio: real("trace_sample_ratio").notNull().default(1),
	alwaysKeepErrorSpans: integer("always_keep_error_spans", { mode: "boolean" }).notNull().default(true),
	alwaysKeepSlowSpansMs: integer("always_keep_slow_spans_ms"),
	createdAt: integer("created_at")
		.notNull()
		.default(sql`(unixepoch('subsec') * 1000)`),
	updatedAt: integer("updated_at")
		.notNull()
		.default(sql`(unixepoch('subsec') * 1000)`),
})
