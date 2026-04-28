import { HttpServerRequest } from "effect/unstable/http"
import { CurrentTenant } from "@maple/domain/http"
import { Effect, Layer } from "effect"
import { makeResolveTenant } from "./AuthService"
import { Env } from "./Env"

export const AuthorizationLive = Layer.effect(
	CurrentTenant.Authorization,
	Effect.gen(function* () {
		const env = yield* Env
		const resolveTenant = makeResolveTenant(env)

		return CurrentTenant.Authorization.of({
			bearer: (httpEffect) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					const tenant = yield* resolveTenant(request.headers)
					return yield* Effect.provideService(
						httpEffect,
						CurrentTenant.Context,
						new CurrentTenant.TenantSchema(tenant),
					)
				}),
		})
	}),
)
