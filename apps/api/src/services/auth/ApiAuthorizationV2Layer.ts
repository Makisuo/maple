import { HttpServerRequest } from "effect/unstable/http"
import { CurrentTenant, RoleName } from "@maple/domain/http"
import {
	AuthorizationV2,
	requiredScopeForRequest,
	scopeAllows,
	V2InsufficientScope,
	V2InvalidCredentials,
	V2OrganizationAccessDenied,
	V2RateLimited,
} from "@maple/domain/http/v2"
import { Effect, Layer, Option, Schema } from "effect"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { ORG_SELECTION_HEADER } from "@maple/auth"
import { makeResolveTenant } from "./AuthService"
import { OrgMembershipService } from "@/services/auth/OrgMembershipService"
import { annotateAuthSpan } from "@/services/auth/auth-span"
import { Env } from "@/platform/Env"
import {
	API_V2_RATE_LIMIT_PERIOD_SECONDS,
	API_V2_RATE_LIMIT_REQUESTS,
	ApiV2RateLimiter,
	apiV2RateLimitKey,
} from "./ApiV2RateLimiter"

const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const apiKeyDefaultRoles = [decodeRoleNameSync("root")] as const

const getBearerToken = (headers: Record<string, string | undefined>): string | undefined => {
	const header = headers["authorization"] ?? headers["Authorization"]
	if (!header) return undefined
	const [scheme, token] = header.split(" ")
	if (!scheme || !token || scheme.toLowerCase() !== "bearer") return undefined
	return token
}

const getOrgSelectionHeader = (headers: Record<string, string | undefined>): string | undefined =>
	headers[ORG_SELECTION_HEADER] ?? headers[ORG_SELECTION_HEADER.toUpperCase()]

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
		const rateLimiter = yield* ApiV2RateLimiter
		// The one resolver wired for organization selection: `x-maple-org-id` is
		// a v2-client affordance (the iOS app publishing a widget snapshot per
		// organization), and every other resolver rejects the header instead.
		//
		// Optional so a route test can build this layer without a membership
		// directory. Absent, the header is *rejected* rather than ignored — a
		// runtime that forgot to wire it serves 403s, never another org's data.
		const membership = yield* Effect.serviceOption(OrgMembershipService)
		const resolveTenant = makeResolveTenant(
			env,
			undefined,
			undefined,
			Option.match(membership, { onNone: () => undefined, onSome: (service) => service.verify }),
		)

		return AuthorizationV2.of({
			bearer: (httpEffect) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest

					const token = getBearerToken(request.headers)
					const apiKeyResolved = yield* apiKeys.resolveByBearer(token)

					if (Option.isSome(apiKeyResolved)) {
						const resolved = apiKeyResolved.value
						if (resolved.kind !== "standard") {
							return yield* Effect.fail(
								V2InvalidCredentials.make("This API key is only valid for the MCP server."),
							)
						}

						// Attribute before the scope check so scope-rejected
						// requests are still counted as API-key traffic.
						yield* annotateAuthSpan("api_key", {
							orgId: resolved.orgId,
							userId: resolved.userId,
							keyId: resolved.keyId,
						})

						const rateLimitOutcome = yield* rateLimiter.check(apiV2RateLimitKey(resolved.keyId))
						yield* Effect.annotateCurrentSpan({
							"maple.rate_limit.outcome": rateLimitOutcome,
							"maple.rate_limit.limit": API_V2_RATE_LIMIT_REQUESTS,
							"maple.rate_limit.period_seconds": API_V2_RATE_LIMIT_PERIOD_SECONDS,
						})

						if (rateLimitOutcome === "limited") {
							return yield* Effect.fail(
								V2RateLimited.make(undefined, {
									retryAfterSeconds: API_V2_RATE_LIMIT_PERIOD_SECONDS,
								}),
							)
						}

						const required = requiredScopeForRequest(request.method, requestPath(request.url))
						if (required !== null && !scopeAllows(resolved.scopes, required)) {
							return yield* Effect.fail(
								V2InsufficientScope.make(
									`This API key does not have the "${required.family}:${required.access}" scope required for this request.`,
								),
							)
						}

						// An API key is already organization-bound, so a selection could
						// only ever widen it. This path returns before `resolveTenant`
						// runs, so the guard inside the resolver never sees it — the
						// check has to be here too.
						const requestedOrg = getOrgSelectionHeader(request.headers)
						if (requestedOrg !== undefined && requestedOrg !== resolved.orgId) {
							return yield* Effect.fail(
								V2OrganizationAccessDenied.make(
									"An API key cannot select a different organization.",
								),
							)
						}

						const tenant = new CurrentTenant.TenantSchema({
							orgId: resolved.orgId,
							userId: resolved.userId,
							roles: resolved.roles ?? apiKeyDefaultRoles,
							authMode: "self_hosted",
							...(resolved.scopes !== null ? { scopes: resolved.scopes } : undefined),
						})
						return yield* Effect.provideService(httpEffect, CurrentTenant.Context, tenant)
					}

					const tenant = yield* resolveTenant(request.headers).pipe(
						Effect.catchTag("@maple/http/errors/OrganizationAccessDeniedError", (error) =>
							Effect.fail(V2OrganizationAccessDenied.make(error.message)),
						),
					)
					yield* annotateAuthSpan("session", { orgId: tenant.orgId, userId: tenant.userId })
					return yield* Effect.provideService(
						httpEffect,
						CurrentTenant.Context,
						new CurrentTenant.TenantSchema(tenant),
					)
				}),
		})
	}),
)
