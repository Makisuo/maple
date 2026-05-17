import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const orgOnboardingState = sqliteTable("org_onboarding_state", {
	orgId: text("org_id").notNull().primaryKey(),
	userId: text("user_id"),
	email: text("email"),
	role: text("role"),
	demoDataRequested: integer("demo_data_requested", { mode: "number" }).notNull().default(0),
	onboardingCompletedAt: integer("onboarding_completed_at", { mode: "number" }),
	checklistDismissedAt: integer("checklist_dismissed_at", { mode: "number" }),
	firstDataReceivedAt: integer("first_data_received_at", { mode: "number" }),
	welcomeEmailSentAt: integer("welcome_email_sent_at", { mode: "number" }),
	connectNudgeEmailSentAt: integer("connect_nudge_email_sent_at", { mode: "number" }),
	stalledEmailSentAt: integer("stalled_email_sent_at", { mode: "number" }),
	activationEmailSentAt: integer("activation_email_sent_at", { mode: "number" }),
	createdAt: integer("created_at", { mode: "number" }).notNull(),
	updatedAt: integer("updated_at", { mode: "number" }).notNull(),
})

export type OrgOnboardingStateRow = typeof orgOnboardingState.$inferSelect
