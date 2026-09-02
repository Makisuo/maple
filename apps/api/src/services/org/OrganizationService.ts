import { createClerkClient } from "@clerk/backend"
import {
	DeleteOrganizationResponse,
	OrganizationForbiddenError,
	OrganizationPersistenceError,
	OrganizationProviderError,
	OrgId,
	RoleName,
} from "@maple/domain/http"
import {
	actors,
	alertDeliveryEvents,
	alertDestinations,
	alertIncidents,
	alertRuleStates,
	alertRules,
	apiKeys,
	cliDeviceAuthorizations,
	cloudflareLogpushConnectors,
	dashboards,
	dashboardShares,
	dashboardVersions,
	digestSubscriptions,
	errorIncidents,
	errorIssueEvents,
	errorIssueStates,
	errorIssues,
	errorNotificationPolicies,
	liveActivities,
	mcpOAuthAuthorizations,
	mcpOAuthRefreshTokens,
	mobileDevices,
	oauthAuthStates,
	oauthConnections,
	orgClickHouseSettings,
	orgIngestKeys,
	planetscaleConnections,
	scrapeTargets,
	slackWorkspaces,
	vcsCommits,
	vcsInstallations,
	vcsRepositories,
} from "@maple/db"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { Env } from "@/platform/Env"
import { clerkRequest } from "@/services/auth/clerk-request"

const ROOT_ROLE = Schema.decodeSync(RoleName)("root")
const ORG_ADMIN_ROLE = Schema.decodeSync(RoleName)("org:admin")

const isOrgAdmin = (roles: ReadonlyArray<RoleName>) =>
	roles.includes(ROOT_ROLE) || roles.includes(ORG_ADMIN_ROLE)

const toPersistenceError = (error: unknown) =>
	new OrganizationPersistenceError({
		message: error instanceof Error ? error.message : "Organization persistence failed",
	})

const toProviderError = (error: unknown) =>
	new OrganizationProviderError({
		message: error instanceof Error ? error.message : "Organization provider call failed",
	})

const ORG_SCOPED_TABLES = [
	dashboardVersions,
	dashboards,
	alertDeliveryEvents,
	alertIncidents,
	alertRuleStates,
	alertRules,
	alertDestinations,
	apiKeys,
	orgIngestKeys,
	orgClickHouseSettings,
	scrapeTargets,
	oauthConnections,
	oauthAuthStates,
	// Holds an encrypted Slack bot token and the id of a full-access API key —
	// there is no `orgs` table to cascade from, so this purge is what stops a
	// deleted org's live credentials outliving it.
	slackWorkspaces,
	digestSubscriptions,
	cloudflareLogpushConnectors,
	errorIssueEvents,
	errorIssueStates,
	errorIncidents,
	errorIssues,
	errorNotificationPolicies,
	actors,
	vcsInstallations,
	vcsRepositories,
	vcsCommits,
	// Credentials that outlive the org unless they are purged here. `api_keys`
	// alone was not enough: an MCP grant's refresh family re-mints its key
	// hourly, so a deleted org's MCP client kept working for up to 30 days.
	mcpOAuthRefreshTokens,
	mobileDevices,
	// A share link is a public bearer credential: `resolveByToken` matches the
	// token hash and `revoked_at is null` and nothing else, then queries the
	// warehouse as the org. It only went dead on deletion by accident of a
	// downstream `dashboards` lookup, which is not a guarantee.
	dashboardShares,
	// Holds the encrypted per-connection webhook HMAC secret — standing
	// authority to have inbound writes attributed to an org that is gone.
	planetscaleConnections,
	// APNs update tokens for running Live Activities. `mobile_devices` is purged
	// here already; leaving these behind keeps a live push channel open.
	liveActivities,
] as const

/**
 * Same purge, different column: these two record an *approval* rather than
 * ownership, so the org they belong to is `approved_org_id`.
 */
const APPROVED_ORG_SCOPED_TABLES = [mcpOAuthAuthorizations, cliDeviceAuthorizations] as const

/**
 * Org-scoped tables deliberately left behind by `delete`. Every table with an
 * `org_id` must appear in exactly one of these three lists — the registry test
 * in `OrganizationService.org-scoped-tables.test.ts` fails on a new one that
 * appears in none, so "we forgot to register it" cannot happen silently again.
 *
 * Every name below has been read against its schema: none holds a token, hash,
 * ciphertext or other secret, and none is resolved by anything to grant access.
 * They are analytics, settings and history — retained data, which is a
 * retention question and a defensible follow-up, not a live-credential gap.
 * The three that failed that read (`dashboardShares`, `planetscaleConnections`,
 * `liveActivities`) were moved into the purge above rather than excused here.
 */
export const UNPURGED_ORG_SCOPED_TABLES = [
	"aiTriageSettings",
	"alertRuleClaims",
	"anomalyDetectorSettings",
	"anomalyDetectorStates",
	"anomalyIncidents",
	"cloudflareAnalyticsState",
	"cloudflareHyperdriveConfigs",
	"errorFingerprintCandidates",
	"errorIssuePullRequests",
	"errorIssueVerifications",
	"errorNotificationDeliveries",
	"errorTickStates",
	"investigationLensRuns",
	"investigations",
	"issueEscalationPolicies",
	"issueEscalations",
	"orgClickHouseSchemaApplyRuns",
	"orgIngestAttributeMappings",
	"orgIngestSamplingPolicies",
	"orgOnboardingState",
	"orgRecommendationIssues",
	"planetscaleDatabases",
	"planetscaleEvents",
	"planetscalePollState",
	"scrapeTargetChecks",
	"vcsRepositoryBranches",
] as const

export const ORG_DELETE_REGISTRY = {
	orgScoped: ORG_SCOPED_TABLES,
	approvedOrgScoped: APPROVED_ORG_SCOPED_TABLES,
	unpurged: UNPURGED_ORG_SCOPED_TABLES,
} as const

/** Read model for the org identity — sourced from Clerk when available. */
export interface OrganizationInfo {
	readonly id: OrgId
	readonly name: string | null
	readonly slug: string | null
	/**
	 * The org's own logo, or `null` when it never uploaded one.
	 *
	 * Clerk always hands back a URL — it generates an initials avatar when
	 * `hasImage` is false — so the flag is what separates "this is their mark"
	 * from "this is a placeholder Clerk drew". Callers that want a placeholder
	 * should draw their own rather than ship Clerk's into a Maple surface.
	 */
	readonly imageUrl: string | null
	readonly createdAtMs: number | null
}

export interface OrganizationServiceApi {
	readonly retrieve: (orgId: OrgId) => Effect.Effect<OrganizationInfo, OrganizationProviderError>
	readonly delete: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		DeleteOrganizationResponse,
		OrganizationForbiddenError | OrganizationPersistenceError | OrganizationProviderError
	>
}

export class OrganizationService extends Context.Service<OrganizationService, OrganizationServiceApi>()(
	"@maple/api/services/OrganizationService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env

			const requireAdmin = Effect.fn("OrganizationService.requireAdmin")(function* (
				roles: ReadonlyArray<RoleName>,
			) {
				if (isOrgAdmin(roles)) return
				return yield* Effect.fail(
					new OrganizationForbiddenError({
						message: "Only org admins can delete the organization",
					}),
				)
			})

			const purgeOrgScopedRows = Effect.fn("OrganizationService.purgeOrgScopedRows")(function* (
				orgId: OrgId,
			) {
				yield* Effect.forEach(
					ORG_SCOPED_TABLES,
					(table) =>
						database
							.execute((db) => db.delete(table).where(eq(table.orgId, orgId)))
							.pipe(Effect.mapError(toPersistenceError)),
					{ discard: true },
				)
				yield* Effect.forEach(
					APPROVED_ORG_SCOPED_TABLES,
					(table) =>
						database
							.execute((db) => db.delete(table).where(eq(table.approvedOrgId, orgId)))
							.pipe(Effect.mapError(toPersistenceError)),
					{ discard: true },
				)
			})

			/** The Clerk backend client, or `None` when not running in Clerk auth mode. */
			const clerkClient = () =>
				env.MAPLE_AUTH_MODE.toLowerCase() === "clerk" && Option.isSome(env.CLERK_SECRET_KEY)
					? Option.some(
							createClerkClient({ secretKey: Redacted.value(env.CLERK_SECRET_KEY.value) }),
						)
					: Option.none()

			const deleteClerkOrganization = Effect.fn("OrganizationService.deleteClerkOrganization")(
				function* (orgId: OrgId) {
					yield* Effect.annotateCurrentSpan("orgId", orgId)
					const clerk = clerkClient()
					if (Option.isNone(clerk)) return

					yield* clerkRequest("Clerk.organizations.deleteOrganization", { orgId }, () =>
						clerk.value.organizations.deleteOrganization(orgId),
					).pipe(Effect.mapError((error) => toProviderError(error.cause)))
				},
			)

			/**
			 * The caller's org identity. In Clerk mode it is read from Clerk; in
			 * self-hosted mode there is no directory, so name/slug/createdAt are null
			 * and only the id is meaningful.
			 */
			const retrieve = Effect.fn("OrganizationService.retrieve")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				const clerk = clerkClient()
				if (Option.isNone(clerk)) {
					return {
						id: orgId,
						name: null,
						slug: null,
						imageUrl: null,
						createdAtMs: null,
					} satisfies OrganizationInfo
				}
				const org = yield* clerkRequest("Clerk.organizations.getOrganization", { orgId }, () =>
					clerk.value.organizations.getOrganization({ organizationId: orgId }),
				).pipe(Effect.mapError((error) => toProviderError(error.cause)))
				return {
					id: orgId,
					name: org.name,
					slug: org.slug,
					imageUrl: org.hasImage ? org.imageUrl : null,
					createdAtMs: org.createdAt,
				} satisfies OrganizationInfo
			})

			const deleteOrganization = Effect.fn("OrganizationService.delete")(function* (
				orgId: OrgId,
				roles: ReadonlyArray<RoleName>,
			) {
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				yield* requireAdmin(roles)
				yield* purgeOrgScopedRows(orgId)
				yield* deleteClerkOrganization(orgId)
				return new DeleteOrganizationResponse({ deleted: true })
			})

			return {
				retrieve,
				delete: deleteOrganization,
			} satisfies OrganizationServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)

	static readonly retrieve = (orgId: OrgId) => this.use((service) => service.retrieve(orgId))

	static readonly delete = (orgId: OrgId, roles: ReadonlyArray<RoleName>) =>
		this.use((service) => service.delete(orgId, roles))
}
