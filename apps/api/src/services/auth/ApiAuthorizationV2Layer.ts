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
import { CurrentAuditActor } from "@/services/auth/audit-actor"
import { AuditLogService } from "@/services/audit/AuditLogService"
import { recordApiDenial } from "@/services/auth/audit-denial"
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

/** `HttpServerRequest` lowercases every incoming header, and the constant is
 * already lowercase — so this is a plain lookup, not a case-insensitive one. */
const getOrgSelectionHeader = (headers: Record<string, string | undefined>): string | undefined =>
	headers[ORG_SELECTION_HEADER]

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
		const audit = yield* AuditLogService
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
						// A refused attempt is the highest-signal audit row there is —
						// denials carry the same actor attribution as successes, tagged
						// `outcome: "denied"`, coalesced so a looping client cannot
						// amplify into unbounded rows.
						const recordDenied = (denialReason: string) =>
							recordApiDenial(audit, request, {
								orgId: resolved.orgId,
								userId: resolved.userId,
								apiKeyId: resolved.keyId,
								denialReason,
							})
						// Deny-list, not an allow-list: `mcp` keys are minted through a
						// path that does not gate on organization admin, so they must
						// never reach the public API. `device` keys are admitted
						// because every ceiling they have — scopes, TTL, and the
						// pinned roles below — is chosen by the server that minted
						// them, not by whatever is holding them.
						if (resolved.kind === "mcp") {
							const message = "This API key is only valid for the MCP server."
							yield* recordDenied(message)
							return yield* Effect.fail(V2InvalidCredentials.make(message))
						}

						// A device credential's authority is entirely its pinned
						// roles, and `apiKeyDefaultRoles` below is `root`. A device
						// row that reaches here without them is not a key with a
						// permissive default — it is a key whose defining property
						// is missing, so it is rejected rather than promoted.
						if (resolved.kind === "device" && resolved.roles === null) {
							const message = "This device credential is not valid."
							yield* recordDenied(message)
							return yield* Effect.fail(V2InvalidCredentials.make(message))
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
							const message = `This API key does not have the "${required.family}:${required.access}" scope required for this request.`
							yield* recordDenied(message)
							return yield* Effect.fail(V2InsufficientScope.make(message))
						}

						// An API key is already organization-bound, so a selection could
						// only ever widen it. This path returns before `resolveTenant`
						// runs, so the guard inside the resolver never sees it — the
						// check has to be here too.
						const requestedOrg = getOrgSelectionHeader(request.headers)
						if (requestedOrg !== undefined && requestedOrg !== resolved.orgId) {
							const message = "An API key cannot select a different organization."
							yield* recordDenied(message)
							return yield* Effect.fail(V2OrganizationAccessDenied.make(message))
						}

						const tenant = new CurrentTenant.TenantSchema({
							orgId: resolved.orgId,
							userId: resolved.userId,
							roles: resolved.roles ?? apiKeyDefaultRoles,
							authMode: "self_hosted",
							...(resolved.scopes !== null ? { scopes: resolved.scopes } : undefined),
						})
						return yield* httpEffect.pipe(
							Effect.provideService(CurrentTenant.Context, tenant),
							Effect.provideService(CurrentAuditActor, {
								type: "api_key",
								apiKeyId: resolved.keyId,
							}),
						)
					}

					const tenant = yield* resolveTenant(request.headers).pipe(
						Effect.catchTag("@maple/http/errors/OrganizationAccessDeniedError", (error) =>
							Effect.fail(V2OrganizationAccessDenied.make(error.message)),
						),
					)
					yield* annotateAuthSpan("session", { orgId: tenant.orgId, userId: tenant.userId })
					return yield* httpEffect.pipe(
						Effect.provideService(CurrentTenant.Context, new CurrentTenant.TenantSchema(tenant)),
						Effect.provideService(CurrentAuditActor, { type: "user" }),
					)
				}),
		})
	}),
)
