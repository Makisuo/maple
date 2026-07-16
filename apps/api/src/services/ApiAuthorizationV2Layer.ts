import { HttpServerRequest } from "effect/unstable/http"
import { CurrentTenant, RoleName } from "@maple/domain/http"
import {
	AuthorizationV2,
	authenticationError,
	permissionError,
	requiredScopeForRequest,
	scopeAllows,
} from "@maple/domain/http/v2"
import { Effect, Layer, Option, Schema } from "effect"
import { ApiKeysService } from "./ApiKeysService"
import { makeResolveTenant } from "./AuthService"
import { Env } from "../lib/Env"

const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const apiKeyDefaultRoles = [decodeRoleNameSync("root")] as const

const getBearerToken = (headers: Record<string, string | undefined>): string | undefined => {
	const header = headers["authorization"] ?? headers["Authorization"]
	if (!header) return undefined
	const [scheme, token] = header.split(" ")
	if (!scheme || !token || scheme.toLowerCase() !== "bearer") return undefined
	return token
}

const requestPath = (url: string): string => {
	const queryStart = url.indexOf("?")
	return queryStart === -1 ? url : url.slice(0, queryStart)
}

/**
 * v2 flavor of `ApiAuthorizationLayer`: same credential resolution (API key
 * first, then Clerk/self-hosted session token), but errors use the v2
 * envelope and restricted API keys are scope-checked mechanically from the
 * request (family = first path segment under /v2, GET/HEAD → read else write).
 * Session tokens and legacy null-scope keys bypass scope checks.
 */
export const ApiAuthorizationV2Layer = Layer.effect(
	AuthorizationV2,
	Effect.gen(function* () {
		const env = yield* Env
		const apiKeys = yield* ApiKeysService
		const resolveTenant = makeResolveTenant(env)

		return AuthorizationV2.of({
			bearer: (httpEffect) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest

					const token = getBearerToken(request.headers)
					const apiKeyResolved = yield* apiKeys.resolveByBearer(token).pipe(
						Effect.mapError(() =>
							authenticationError("api_key_invalid", "API key validation failed"),
						),
					)

					if (Option.isSome(apiKeyResolved)) {
						const resolved = apiKeyResolved.value

						const required = requiredScopeForRequest(request.method, requestPath(request.url))
						if (required !== null && !scopeAllows(resolved.scopes, required)) {
							return yield* Effect.fail(
								permissionError(
									"insufficient_scope",
									`This API key does not have the "${required.family}:${required.access}" scope required for this request.`,
								),
							)
						}

						const tenant = new CurrentTenant.TenantSchema({
							orgId: resolved.orgId,
							userId: resolved.userId,
							roles: apiKeyDefaultRoles,
							authMode: "self_hosted",
							...(resolved.scopes !== null ? { scopes: resolved.scopes } : {}),
						})
						return yield* Effect.provideService(httpEffect, CurrentTenant.Context, tenant)
					}

					const tenant = yield* resolveTenant(request.headers).pipe(
						Effect.mapError((error) =>
							authenticationError(
								"invalid_credentials",
								error.message || "Invalid or missing credentials",
							),
						),
					)
					return yield* Effect.provideService(
						httpEffect,
						CurrentTenant.Context,
						new CurrentTenant.TenantSchema(tenant),
					)
				}),
		})
	}),
)
