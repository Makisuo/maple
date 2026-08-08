import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import type { OrgId, UserId } from "@maple/domain/primitives"

/**
 * Per-org AI auto-triage policy. Disabled by default, so an admin must opt in.
 * Triage runs on Maple's managed AI (Cloudflare Workers AI via the api worker's
 * `AI` binding) — no per-org model or key configuration is needed.
 */
export const aiTriageSettings = pgTable("ai_triage_settings", {
	orgId: text("org_id").$type<OrgId>().notNull().primaryKey(),
	enabled: boolean("enabled").notNull().default(false),
	maxRunsPerDay: integer("max_runs_per_day").notNull().default(20),
	/**
	 * Daily budget in *model passes*, which is what actually costs money — a
	 * five-lens fan-out is six passes inside one run.
	 *
	 * Deliberately a second column rather than a reinterpretation of
	 * `maxRunsPerDay`: that one is org-configurable and user-visible, and silently
	 * changing its unit from runs to passes would turn a configured 20 into about
	 * three critical incidents a day with no warning and no failing test.
	 *
	 * Default raised from 60 with the planner: an incident spends planner + up to
	 * 4 hypotheses + validator ≈ 6 passes, so 60 was about ten incidents a day and
	 * 90 is about fifteen.
	 */
	maxPassesPerDay: integer("max_passes_per_day").notNull().default(90),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	updatedBy: text("updated_by").$type<UserId>(),
})

export type AiTriageSettingsRow = typeof aiTriageSettings.$inferSelect
