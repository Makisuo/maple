import { HttpServerRequest } from "effect/unstable/http"
import { CurrentTenant, RoleName, UnauthorizedError } from "@maple/domain/http"
import { Effect, Layer, Option, Schema } from "effect"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import { makeResolveTenant } from "./AuthService"
import { annotateAuthSpan } from "@/services/auth/auth-span"
import { CurrentAuditActor } from "@/services/auth/audit-actor"
import { AuditLogService } from "@/services/audit/AuditLogService"
import { Env } from "@/platform/Env"

const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const apiKeyDefaultRoles = [decodeRoleNameSync("root")] as const

const getBearerToken = (headers: Record<string, string | undefined>): string | undefined => {
	const header = headers["authorization"] ?? headers["Authorization"]
	if (!header) return undefined
	const [scheme, token] = header.split(" ")
	if (!scheme || !token || scheme.toLowerCase() !== "bearer") return undefined
	return token
}

export const ApiAuthorizationLayer = Layer.effect(
	CurrentTenant.Authorization,
	Effect.gen(function* () {
		const env = yield* Env
		const apiKeys = yield* ApiKeysService
		const audit = yield* AuditLogService
		const resolveTenant = makeResolveTenant(env)

		return CurrentTenant.Authorization.of({
			bearer: (httpEffect) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest

					const token = getBearerToken(request.headers)
					const apiKeyResolved = yield* apiKeys.resolveByBearer(token).pipe(
						Effect.catchTag("@maple/http/errors/ApiKeyLookupPersistenceError", () =>
							Effect.fail(
								new CurrentTenant.AuthorizationUnavailableError({
									message: "API key validation is temporarily unavailable",
								}),
							),
						),
					)

					if (Option.isSome(apiKeyResolved)) {
						const resolved = apiKeyResolved.value
						// Denied attempts are audited with the same attribution as
						// successes — a key probing a surface it is not valid for is
						// exactly what the audit log exists to surface.
						const recordDenied = (denialReason: string) =>
							audit.record({
								orgId: resolved.orgId,
								actor: {
									type: "api_key",
									userId: resolved.userId,
									apiKeyId: resolved.keyId,
								},
								source: "api",
								action: "api.request",
								outcome: "denied",
								denialReason,
							})
						if (resolved.kind !== "standard") {
							yield* recordDenied("This API key is only valid for the MCP server")
							return yield* new UnauthorizedError({
								message: "This API key is only valid for the MCP server",
							})
						}
						if (resolved.scopes !== null) {
							yield* recordDenied("Restricted API keys must use the /v2 API")
							return yield* new UnauthorizedError({
								message: "Restricted API keys must use the /v2 API",
							})
						}
						yield* annotateAuthSpan("api_key", {
							orgId: resolved.orgId,
							userId: resolved.userId,
							keyId: resolved.keyId,
						})
						const tenant = new CurrentTenant.TenantSchema({
							orgId: resolved.orgId,
							userId: resolved.userId,
							roles: resolved.roles ?? apiKeyDefaultRoles,
							authMode: "self_hosted",
						})
						return yield* httpEffect.pipe(
							Effect.provideService(CurrentTenant.Context, tenant),
							Effect.provideService(CurrentAuditActor, {
								type: "api_key",
								apiKeyId: resolved.keyId,
							}),
						)
					}

					const tenant = yield* resolveTenant(request.headers)
					yield* annotateAuthSpan("session", { orgId: tenant.orgId, userId: tenant.userId })
					return yield* httpEffect.pipe(
						Effect.provideService(CurrentTenant.Context, new CurrentTenant.TenantSchema(tenant)),
						Effect.provideService(CurrentAuditActor, { type: "user" }),
					)
				}),
		})
	}),
)
