import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"

/**
 * Per-org spend guardrails: one monthly ceiling on estimated spend, the alert
 * thresholds that fire before it, and optional per-feature volume caps.
 *
 * One row per org, written from the billing page. Absence of a row means "no
 * limits configured" — the default, and the only state the ingest gateway can
 * reach without a join hit.
 *
 * Evaluation state (`breachedAt` / `pausedAt` / `notifiedThresholds`) is derived,
 * not user input: the hourly spend-limit cron recomputes cycle spend and stamps
 * it here so the ingest gateway can gate on a single boolean instead of pricing
 * usage in the hot path. `pausedAt` is only ever set when
 * `enforcementMode = 'pause'`, which is what makes "data is never dropped
 * without warning first" true — a notify-only org breaches loudly and keeps
 * ingesting.
 */
export const orgSpendLimits = pgTable("org_spend_limits", {
	orgId: text("org_id").primaryKey().notNull(),
	/**
	 * Ceiling on estimated cycle spend, in cents. Null = no ceiling (per-feature
	 * caps may still apply). Cents, not dollars: this is money and a float would
	 * drift against the invoice.
	 */
	monthlyLimitCents: integer("monthly_limit_cents"),
	/** `"notify"` (alert only) or `"pause"` (402 at the ingest gateway on breach). */
	enforcementMode: text("enforcement_mode").notNull().default("notify"),
	/** Percentages of the limit that fire an alert, e.g. `[80, 100]`. */
	alertThresholdPercents: jsonb("alert_threshold_percents")
		.$type<ReadonlyArray<number>>()
		.notNull()
		.default([80, 100]),
	/**
	 * Per-feature volume ceilings for the cycle, keyed by Autumn featureId
	 * (`logs` / `traces` / `metrics` in GB, `browser_sessions` as a count). A
	 * missing or null entry means "no cap — overage billed at the plan rate".
	 */
	featureCaps: jsonb("feature_caps").$type<Record<string, number | null>>().notNull().default({}),

	// ---- Derived evaluation state (written by the spend-limit cron) ----
	lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true, mode: "date" }),
	/** Estimated cycle spend at `lastEvaluatedAt`, in cents. */
	evaluatedSpendCents: integer("evaluated_spend_cents"),
	/** First evaluation in the current cycle that found spend at or over the limit. */
	breachedAt: timestamp("breached_at", { withTimezone: true, mode: "date" }),
	/** Set only when `enforcementMode = 'pause'` and the limit is breached. */
	pausedAt: timestamp("paused_at", { withTimezone: true, mode: "date" }),
	/**
	 * Features whose per-cycle cap is exceeded, as Autumn featureIds. The ingest
	 * gateway already gates per signal, so a cap pauses only its own signal —
	 * blowing the logs cap must not stop traces. Independent of `pausedAt`, which
	 * is the whole-org spend ceiling.
	 */
	pausedFeatures: jsonb("paused_features").$type<ReadonlyArray<string>>().notNull().default([]),
	/** Thresholds already notified this cycle, so a threshold alerts once. */
	notifiedThresholds: jsonb("notified_thresholds").$type<ReadonlyArray<number>>().notNull().default([]),
	/**
	 * Start of the cycle the evaluation state belongs to. When the cycle rolls
	 * over, breach/pause/notified state resets rather than carrying forward.
	 */
	cycleStartedAt: timestamp("cycle_started_at", { withTimezone: true, mode: "date" }),

	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
	updatedBy: text("updated_by"),
})

export type OrgSpendLimitsRow = typeof orgSpendLimits.$inferSelect
export type OrgSpendLimitsInsert = typeof orgSpendLimits.$inferInsert
