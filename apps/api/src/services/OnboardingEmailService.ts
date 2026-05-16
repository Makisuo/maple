import { OrgId, RoleName, UserId } from "@maple/domain/http"
import type { RoleName as RoleNameType } from "@maple/domain/http"
import { createClerkClient } from "@clerk/backend"
import { render } from "@react-email/components"
import {
	ActivationEmail,
	ConnectAppEmail,
	StalledEmail,
	WelcomeEmail,
} from "@maple/email/onboarding"
import { Cause, Context, Effect, Layer, Option, Redacted } from "effect"
import { EmailService } from "./EmailService"
import { Env } from "./Env"
import { OnboardingService } from "./OnboardingService"
import type { OnboardingEmailField } from "./OnboardingService"
import { WarehouseQueryService } from "./WarehouseQueryService"

const SYSTEM_ONBOARDING_USER = UserId.make("system-onboarding")
const ROOT_ROLE = RoleName.make("root")

const DAY_MS = 24 * 60 * 60 * 1000
/** Wait this long with no telemetry before nudging the user to connect an app. */
const CONNECT_NUDGE_AFTER_MS = DAY_MS
/** Wait this long with no telemetry before the stalled re-engagement email. */
const STALLED_AFTER_MS = 3 * DAY_MS

/** The element type accepted by `@react-email/components`'s `render` — derived
 * here so this file doesn't need a direct `react` type dependency. */
type EmailNode = Parameters<typeof render>[0]

const toClickHouseDateTime = (d: Date) =>
	d
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d{3}Z$/, "")

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

export class OnboardingEmailService extends Context.Service<OnboardingEmailService>()(
	"OnboardingEmailService",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const email = yield* EmailService
			const onboarding = yield* OnboardingService
			const warehouse = yield* WarehouseQueryService

			/**
			 * Returns true if the org has any non-demo telemetry in the last 30 days.
			 * Reuses the `service_overview_compare` query (same one the weekly digest
			 * uses); the previous window is zero-width so only current rows return.
			 */
			const orgHasRealTelemetry = Effect.fn("OnboardingEmailService.orgHasRealTelemetry")(
				function* (orgId: OrgId) {
					const now = new Date()
					const currentEnd = toClickHouseDateTime(now)
					const currentStart = toClickHouseDateTime(new Date(now.getTime() - 30 * DAY_MS))

					const systemTenant = {
						orgId,
						userId: SYSTEM_ONBOARDING_USER,
						roles: [ROOT_ROLE] as ReadonlyArray<RoleNameType>,
						authMode: "self_hosted" as const,
					}

					const response = yield* warehouse.query(systemTenant, {
						pipe: "service_overview_compare",
						params: {
							current_start_time: currentStart,
							current_end_time: currentEnd,
							previous_start_time: currentStart,
							previous_end_time: currentStart,
						},
					})

					const rows: ReadonlyArray<unknown> = Array.isArray(response.data)
						? response.data
						: []
					return rows.some((row) => {
						if (!isRecord(row)) return false
						const name = row.serviceName
						return typeof name === "string" && !name.startsWith("demo-")
					})
				},
			)

			/**
			 * Ensure an onboarding row exists for every Clerk org, keyed on the org's
			 * first member (used as the email recipient). Clerk-mode only — mirrors
			 * DigestService's subscription sync.
			 */
			const ensureRowsFromClerk = Effect.fn("OnboardingEmailService.ensureRowsFromClerk")(
				function* () {
					if (env.MAPLE_AUTH_MODE.toLowerCase() !== "clerk") return 0
					if (Option.isNone(env.CLERK_SECRET_KEY)) return 0

					const clerk = createClerkClient({
						secretKey: Redacted.value(env.CLERK_SECRET_KEY.value),
					})

					const paginate = <T>(
						fetchPage: (params: {
							limit: number
							offset: number
						}) => Promise<{ data: T[]; totalCount: number }>,
					) =>
						Effect.gen(function* () {
							const PAGE_SIZE = 100
							let offset = 0
							const all: T[] = []
							while (true) {
								const page = yield* Effect.tryPromise({
									try: () => fetchPage({ limit: PAGE_SIZE, offset }),
									catch: (cause) => cause,
								})
								all.push(...page.data)
								offset += page.data.length
								if (offset >= page.totalCount || page.data.length === 0) break
							}
							return all
						})

					const orgs = yield* paginate((params) =>
						clerk.organizations.getOrganizationList(params),
					)

					let ensured = 0
					for (const org of orgs) {
						const members = yield* paginate((params) =>
							clerk.organizations.getOrganizationMembershipList({
								organizationId: org.id,
								...params,
							}),
						)
						const firstMember = members.find(
							(m) => m.publicUserData?.identifier && m.publicUserData?.userId,
						)
						if (!firstMember?.publicUserData) continue

						yield* onboarding.ensureRow(
							OrgId.make(org.id),
							firstMember.publicUserData.userId,
							firstMember.publicUserData.identifier,
						)
						ensured += 1
					}
					return ensured
				},
			)

			const renderEmail = (node: EmailNode) =>
				Effect.tryPromise({
					try: () => render(node),
					catch: (cause) => cause,
				})

			const runOnboardingTick = Effect.fn("OnboardingEmailService.runOnboardingTick")(
				function* () {
					if (!email.isConfigured) {
						return {
							ensuredCount: 0,
							sentCount: 0,
							errorCount: 0,
							firstDataDetected: 0,
							skipped: true,
						}
					}

					const ensuredCount = yield* ensureRowsFromClerk().pipe(
						Effect.catchCause((cause) =>
							Effect.logWarning("Failed to sync onboarding rows from Clerk")
								.pipe(Effect.annotateLogs({ error: Cause.pretty(cause) }))
								.pipe(Effect.as(0)),
						),
					)

					const rows = yield* onboarding.listAll()
					const now = Date.now()
					const dashboardUrl = env.MAPLE_APP_BASE_URL

					const results = yield* Effect.forEach(
						rows,
						(row) =>
							Effect.gen(function* () {
								const orgId = OrgId.make(row.orgId)
								let firstDataReceivedAt = row.firstDataReceivedAt
								let firstDataDetected = false

								if (firstDataReceivedAt == null) {
									const hasData = yield* orgHasRealTelemetry(orgId).pipe(
										Effect.orElseSucceed(() => false),
									)
									if (hasData) {
										const stamped =
											yield* onboarding.recordFirstDataReceived(orgId)
										if (stamped) {
											firstDataReceivedAt = now
											firstDataDetected = true
										}
									}
								}

								// Decide which single email (if any) is due this tick.
								const ageMs = now - row.createdAt
								let template: EmailNode | null = null
								let subject = ""
								let field: OnboardingEmailField | null = null

								if (row.welcomeEmailSentAt == null) {
									template = WelcomeEmail({ dashboardUrl })
									subject = "Welcome to Maple"
									field = "welcomeEmailSentAt"
								} else if (
									firstDataReceivedAt != null &&
									row.activationEmailSentAt == null
								) {
									template = ActivationEmail({ dashboardUrl })
									subject = "You're live on Maple"
									field = "activationEmailSentAt"
								} else if (
									firstDataReceivedAt == null &&
									row.connectNudgeEmailSentAt == null &&
									ageMs >= CONNECT_NUDGE_AFTER_MS
								) {
									template = ConnectAppEmail({ dashboardUrl })
									subject = "Connect your app to Maple"
									field = "connectNudgeEmailSentAt"
								} else if (
									firstDataReceivedAt == null &&
									row.stalledEmailSentAt == null &&
									ageMs >= STALLED_AFTER_MS
								) {
									template = StalledEmail({ dashboardUrl })
									subject = "Need a hand connecting your app?"
									field = "stalledEmailSentAt"
								}

								if (!template || !field || !row.email) {
									return { sent: false, failed: false, firstDataDetected }
								}

								const html = yield* renderEmail(template)
								yield* email.send(row.email, subject, html)
								yield* onboarding.markEmailSent(orgId, field)

								return { sent: true, failed: false, firstDataDetected }
							}).pipe(
								Effect.catchCause((cause) =>
									Effect.logError("Onboarding email failed for org")
										.pipe(
											Effect.annotateLogs({
												orgId: row.orgId,
												error: Cause.pretty(cause),
											}),
										)
										.pipe(
											Effect.as({
												sent: false,
												failed: true,
												firstDataDetected: false,
											}),
										),
								),
							),
						{ concurrency: 2 },
					)

					const sentCount = results.filter((r) => r.sent).length
					const errorCount = results.filter((r) => r.failed).length
					const firstDataDetected = results.filter((r) => r.firstDataDetected).length

					yield* Effect.annotateCurrentSpan("ensuredCount", ensuredCount)
					yield* Effect.annotateCurrentSpan("sentCount", sentCount)
					yield* Effect.annotateCurrentSpan("errorCount", errorCount)
					yield* Effect.annotateCurrentSpan("firstDataDetected", firstDataDetected)

					return {
						ensuredCount,
						sentCount,
						errorCount,
						firstDataDetected,
						skipped: false,
					}
				},
			)

			return { runOnboardingTick }
		}),
	},
) {
	static readonly Default = Layer.effect(this, this.make)
	static readonly layer = Layer.effect(this, this.make)
	static readonly Live = Layer.effect(this, this.make)
}
