import type { OrgId } from "@maple/domain"
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const orgOnboardingState = pgTable("org_onboarding_state", {
	orgId: text("org_id").$type<OrgId>().notNull().primaryKey(),
	userId: text("user_id"),
	email: text("email"),
	role: text("role"),
	demoDataRequested: boolean("demo_data_requested").notNull().default(false),
	onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true, mode: "date" }),
	checklistDismissedAt: timestamp("checklist_dismissed_at", { withTimezone: true, mode: "date" }),
	firstDataReceivedAt: timestamp("first_data_received_at", { withTimezone: true, mode: "date" }),
	welcomeEmailSentAt: timestamp("welcome_email_sent_at", { withTimezone: true, mode: "date" }),
	connectNudgeEmailSentAt: timestamp("connect_nudge_email_sent_at", { withTimezone: true, mode: "date" }),
	stalledEmailSentAt: timestamp("stalled_email_sent_at", { withTimezone: true, mode: "date" }),
	activationEmailSentAt: timestamp("activation_email_sent_at", { withTimezone: true, mode: "date" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
})

export type OrgOnboardingStateRow = typeof orgOnboardingState.$inferSelect
