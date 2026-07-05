import {
	SelfHostedAuthDisabledError,
	SelfHostedInvalidPasswordError,
	SelfHostedLoginResponse,
	UnauthorizedError,
} from "@maple/domain/http"
import {
	type AuthEnv,
	makeGetCustomerData,
	makeGetUserEmail,
	makeLoginSelfHosted,
	makeResolveMcpTenant,
	makeResolveTenant,
	type TenantContext,
} from "@maple/auth"
import { Context, Effect, Layer } from "effect"
import { Env } from "../lib/Env"

// The pure tenant-resolution + self-hosted login primitives live in the shared
// `@maple/auth` package (consumed by apps/api AND the standalone
// `apps/electric-sync` worker). This module is the apps/api-flavoured wrapper: an
// `AuthService` Context.Service that binds those primitives to the app's `Env`.
// Re-exported so existing `from "./AuthService"` / `@/services/AuthService`
// imports keep resolving.
export { type AuthEnv, makeResolveTenant, type TenantContext }

type HeaderRecord = Record<string, string | undefined>

export interface AuthServiceShape {
	readonly resolveTenant: (headers: HeaderRecord) => Effect.Effect<TenantContext, UnauthorizedError>
	readonly resolveMcpTenant: (headers: HeaderRecord) => Effect.Effect<TenantContext, UnauthorizedError>
	readonly loginSelfHosted: (
		password: string,
	) => Effect.Effect<SelfHostedLoginResponse, SelfHostedAuthDisabledError | SelfHostedInvalidPasswordError>
	readonly getUserEmail: (userId: string) => Effect.Effect<string | null>
	readonly getCustomerData: (
		tenant: TenantContext,
	) => Effect.Effect<{ email: string | null; orgName: string | null }>
}

export class AuthService extends Context.Service<AuthService, AuthServiceShape>()(
	"@maple/api/services/AuthService",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const resolveTenant = makeResolveTenant(env)
			const resolveMcpTenant = makeResolveMcpTenant(env)
			const loginSelfHosted = makeLoginSelfHosted(env)
			const getUserEmail = makeGetUserEmail(env)
			const getCustomerData = makeGetCustomerData(env)

			return {
				resolveTenant,
				resolveMcpTenant,
				loginSelfHosted,
				getUserEmail,
				getCustomerData,
			} satisfies AuthServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
