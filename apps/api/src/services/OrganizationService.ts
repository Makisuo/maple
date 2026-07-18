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
	cloudflareLogpushConnectors,
	dashboards,
	dashboardVersions,
	digestSubscriptions,
	errorIncidents,
	errorIssueEvents,
	errorIssueStates,
	errorIssues,
	errorNotificationPolicies,
	oauthAuthStates,
	oauthConnections,
	orgClickHouseSettings,
	orgIngestKeys,
	scrapeTargets,
	vcsCommits,
	vcsInstallations,
	vcsRepositories,
} from "@maple/db"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Database } from "../lib/DatabaseLive"
import { Env } from "../lib/Env"

const ROOT_ROLE = Schema.decodeUnknownSync(RoleName)("root")
const ORG_ADMIN_ROLE = Schema.decodeUnknownSync(RoleName)("org:admin")

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
] as const

/** Read model for the org identity — sourced from Clerk when available. */
export interface OrganizationInfo {
	readonly id: OrgId
	readonly name: string | null
	readonly slug: string | null
	readonly createdAtMs: number | null
}

export interface OrganizationServiceShape {
	readonly retrieve: (orgId: OrgId) => Effect.Effect<OrganizationInfo, OrganizationProviderError>
	readonly delete: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		DeleteOrganizationResponse,
		OrganizationForbiddenError | OrganizationPersistenceError | OrganizationProviderError
	>
}

export class OrganizationService extends Context.Service<OrganizationService, OrganizationServiceShape>()(
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
					const clerk = clerkClient()
					if (Option.isNone(clerk)) return

					yield* Effect.tryPromise({
						try: () => clerk.value.organizations.deleteOrganization(orgId),
						catch: toProviderError,
					})
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
					return { id: orgId, name: null, slug: null, createdAtMs: null } satisfies OrganizationInfo
				}
				const org = yield* Effect.tryPromise({
					try: () => clerk.value.organizations.getOrganization({ organizationId: orgId }),
					catch: toProviderError,
				})
				return {
					id: orgId,
					name: org.name,
					slug: org.slug,
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
			} satisfies OrganizationServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)

	static readonly retrieve = (orgId: OrgId) => this.use((service) => service.retrieve(orgId))

	static readonly delete = (orgId: OrgId, roles: ReadonlyArray<RoleName>) =>
		this.use((service) => service.delete(orgId, roles))
}
