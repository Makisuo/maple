import {
	AuthorizationUnavailableError,
	OrganizationAccessDeniedError,
	SelfHostedAuthDisabledError,
	SelfHostedInvalidPasswordError,
	SelfHostedLoginResponse,
	UnauthorizedError,
} from "@maple/domain/http"
import {
	makeGetCustomerData,
	makeGetUserEmail,
	makeLoginSelfHosted,
	makeRefreshSelfHostedSession,
	makeResolveMcpTenant,
	makeResolveTenant,
	type TenantContext,
} from "@maple/auth"
import { Context, Effect, Layer, Option } from "effect"
import { Env } from "@/platform/Env"
import { OrgMembershipService } from "@/services/auth/OrgMembershipService"

// The pure tenant-resolution + self-hosted login primitives live in the shared
// `@maple/auth` package (consumed by apps/api AND the standalone
// `apps/electric-sync` worker). This module is the apps/api-flavoured wrapper: an
// `AuthService` Context.Service that binds those primitives to the app's `Env`.
// Re-exported so existing `from "./AuthService"` / `@/services/AuthService`
// imports keep resolving.
export { makeResolveTenant, type TenantContext }

type HeaderRecord = Record<string, string | undefined>

export interface AuthServiceApi {
	readonly resolveTenant: (
		headers: HeaderRecord,
	) => Effect.Effect<
		TenantContext,
		UnauthorizedError | OrganizationAccessDeniedError | AuthorizationUnavailableError
	>
	/**
	 * Same resolver, wider credentials. It can reject an organization selection
	 * too: `makeResolveMcpTenant` passes no membership verifier, so
	 * `x-maple-org-id` naming anything other than the credential's own
	 * organization is a 403 rather than a silent ignore.
	 */
	readonly resolveMcpTenant: (
		headers: HeaderRecord,
	) => Effect.Effect<
		TenantContext,
		UnauthorizedError | OrganizationAccessDeniedError | AuthorizationUnavailableError
	>
	readonly loginSelfHosted: (
		password: string,
	) => Effect.Effect<SelfHostedLoginResponse, SelfHostedAuthDisabledError | SelfHostedInvalidPasswordError>
	readonly refreshSelfHostedSession: (
		token: string,
	) => Effect.Effect<SelfHostedLoginResponse, SelfHostedAuthDisabledError | UnauthorizedError>
	readonly getUserEmail: (userId: string) => Effect.Effect<string | null>
	readonly getCustomerData: (
		tenant: TenantContext,
	) => Effect.Effect<{ email: string | null; orgName: string | null }>
}

export class AuthService extends Context.Service<AuthService, AuthServiceApi>()(
	"@maple/api/services/AuthService",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			// Optional on purpose. Where it is absent — tests, and any runtime that
			// has not wired it — `makeResolveTenant` rejects `x-maple-org-id`
			// outright rather than ignoring it, which is the safe half of the
			// no-silent-ignore rule.
			const membership = yield* Effect.serviceOption(OrgMembershipService)
			const verifyOrgMembership = Option.match(membership, {
				onNone: () => undefined,
				onSome: (service) => service.verify,
			})
			const resolveTenant = makeResolveTenant(env, undefined, undefined, verifyOrgMembership)
			const resolveMcpTenant = makeResolveMcpTenant(env)
			const loginSelfHosted = makeLoginSelfHosted(env)
			const refreshSelfHostedSession = makeRefreshSelfHostedSession(env)
			const getUserEmail = makeGetUserEmail(env)
			const getCustomerData = makeGetCustomerData(env)

			return {
				resolveTenant,
				resolveMcpTenant,
				loginSelfHosted,
				refreshSelfHostedSession,
				getUserEmail,
				getCustomerData,
			} satisfies AuthServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
