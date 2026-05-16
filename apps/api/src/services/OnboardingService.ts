import { orgOnboardingState } from "@maple/db"
import type { OrgOnboardingStateRow } from "@maple/db"
import { OnboardingPersistenceError, OnboardingStateResponse } from "@maple/domain/http"
import type { OrgId } from "@maple/domain/http"
import { and, eq, isNull } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "./DatabaseLive"

const toPersistenceError = (error: unknown) =>
	new OnboardingPersistenceError({
		message:
			error instanceof Error
				? error.message
				: `Onboarding persistence error: ${String(error)}`,
	})

export type OnboardingEmailField =
	| "welcomeEmailSentAt"
	| "connectNudgeEmailSentAt"
	| "stalledEmailSentAt"
	| "activationEmailSentAt"

export interface OnboardingUpdateInput {
	role?: string
	demoDataRequested?: boolean
	markOnboardingComplete?: boolean
	markChecklistDismissed?: boolean
}

function rowToResponse(row: OrgOnboardingStateRow): OnboardingStateResponse {
	return new OnboardingStateResponse({
		role: row.role ?? null,
		demoDataRequested: row.demoDataRequested === 1,
		onboardingCompletedAt: row.onboardingCompletedAt ?? null,
		checklistDismissedAt: row.checklistDismissedAt ?? null,
		firstDataReceivedAt: row.firstDataReceivedAt ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	})
}

export class OnboardingService extends Context.Service<OnboardingService>()("OnboardingService", {
	make: Effect.gen(function* () {
		const database = yield* Database

		const findRow = (orgId: OrgId) =>
			database
				.execute((db) =>
					db
						.select()
						.from(orgOnboardingState)
						.where(eq(orgOnboardingState.orgId, orgId))
						.limit(1),
				)
				.pipe(
					Effect.mapError(toPersistenceError),
					Effect.map((rows) => rows[0]),
				)

		const ensureRow = Effect.fn("OnboardingService.ensureRow")(function* (
			orgId: OrgId,
			userId?: string,
			email?: string,
		) {
			const existing = yield* findRow(orgId)
			if (existing) return existing

			const now = Date.now()
			yield* database
				.execute((db) =>
					db
						.insert(orgOnboardingState)
						.values({
							orgId,
							userId: userId ?? null,
							email: email ?? null,
							demoDataRequested: 0,
							createdAt: now,
							updatedAt: now,
						})
						.onConflictDoNothing(),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const row = yield* findRow(orgId)
			if (!row) {
				return yield* new OnboardingPersistenceError({
					message: "Failed to create onboarding state row",
				})
			}
			return row
		})

		const getState = Effect.fn("OnboardingService.getState")(function* (
			orgId: OrgId,
			userId?: string,
			email?: string,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			const row = yield* ensureRow(orgId, userId, email)
			return rowToResponse(row)
		})

		const updateState = Effect.fn("OnboardingService.updateState")(function* (
			orgId: OrgId,
			userId: string | undefined,
			email: string | undefined,
			input: OnboardingUpdateInput,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* ensureRow(orgId, userId, email)

			const now = Date.now()
			yield* database
				.execute((db) =>
					db
						.update(orgOnboardingState)
						.set({
							...(input.role != null ? { role: input.role } : {}),
							...(input.demoDataRequested != null
								? { demoDataRequested: input.demoDataRequested ? 1 : 0 }
								: {}),
							...(input.markOnboardingComplete ? { onboardingCompletedAt: now } : {}),
							...(input.markChecklistDismissed ? { checklistDismissedAt: now } : {}),
							...(userId != null ? { userId } : {}),
							...(email != null ? { email } : {}),
							updatedAt: now,
						})
						.where(eq(orgOnboardingState.orgId, orgId)),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const row = yield* findRow(orgId)
			if (!row) {
				return yield* new OnboardingPersistenceError({
					message: "Onboarding state row missing after update",
				})
			}
			return rowToResponse(row)
		})

		/** Stamp first-data time only if not already set. Returns true when newly stamped. */
		const recordFirstDataReceived = Effect.fn("OnboardingService.recordFirstDataReceived")(
			function* (orgId: OrgId) {
				const now = Date.now()
				const result = yield* database
					.execute((db) =>
						db
							.update(orgOnboardingState)
							.set({ firstDataReceivedAt: now, updatedAt: now })
							.where(
								and(
									eq(orgOnboardingState.orgId, orgId),
									isNull(orgOnboardingState.firstDataReceivedAt),
								),
							),
					)
					.pipe(Effect.mapError(toPersistenceError))
				return result.rowsAffected > 0
			},
		)

		const markEmailSent = Effect.fn("OnboardingService.markEmailSent")(function* (
			orgId: OrgId,
			field: OnboardingEmailField,
		) {
			const now = Date.now()
			const set: Partial<typeof orgOnboardingState.$inferInsert> = { updatedAt: now }
			if (field === "welcomeEmailSentAt") set.welcomeEmailSentAt = now
			else if (field === "connectNudgeEmailSentAt") set.connectNudgeEmailSentAt = now
			else if (field === "stalledEmailSentAt") set.stalledEmailSentAt = now
			else set.activationEmailSentAt = now

			yield* database
				.execute((db) =>
					db.update(orgOnboardingState).set(set).where(eq(orgOnboardingState.orgId, orgId)),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		const listAll = Effect.fn("OnboardingService.listAll")(function* () {
			return yield* database
				.execute((db) => db.select().from(orgOnboardingState))
				.pipe(Effect.mapError(toPersistenceError))
		})

		return {
			getState,
			updateState,
			ensureRow,
			recordFirstDataReceived,
			markEmailSent,
			listAll,
		} as const
	}),
}) {
	static readonly Default = Layer.effect(this, this.make)
	static readonly layer = Layer.effect(this, this.make)
	static readonly Live = Layer.effect(this, this.make)
}
