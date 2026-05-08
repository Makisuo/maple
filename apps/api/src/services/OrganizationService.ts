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
	orgOpenrouterSettings,
	scrapeTargets,
} from "@maple/db"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Database } from "./DatabaseLive"
import { Env } from "./Env"

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
	orgOpenrouterSettings,
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
] as const

export interface OrganizationServiceShape {
	readonly delete: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<
		DeleteOrganizationResponse,
		OrganizationForbiddenError | OrganizationPersistenceError | OrganizationProviderError
	>
}

export class OrganizationService extends Context.Service<OrganizationService, OrganizationServiceShape>()(
	"OrganizationService",
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
				for (const table of ORG_SCOPED_TABLES) {
					yield* database
						.execute((db) => db.delete(table).where(eq(table.orgId, orgId)))
						.pipe(Effect.mapError(toPersistenceError))
				}
			})

			const deleteClerkOrganization = Effect.fn("OrganizationService.deleteClerkOrganization")(
				function* (orgId: OrgId) {
					if (env.MAPLE_AUTH_MODE.toLowerCase() !== "clerk") return
					if (Option.isNone(env.CLERK_SECRET_KEY)) return

					const clerk = createClerkClient({
						secretKey: Redacted.value(env.CLERK_SECRET_KEY.value),
					})

					yield* Effect.tryPromise({
						try: () => clerk.organizations.deleteOrganization(orgId),
						catch: toProviderError,
					})
				},
			)

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
				delete: deleteOrganization,
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
	static readonly Live = this.layer
	static readonly Default = this.layer

	static readonly delete = (orgId: OrgId, roles: ReadonlyArray<RoleName>) =>
		this.use((service) => service.delete(orgId, roles))
}
