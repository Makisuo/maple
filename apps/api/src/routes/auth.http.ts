import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	CliDeviceActionResponse,
	CliDeviceConflictError,
	CliDevicePersistenceError,
	CurrentTenant,
	MapleApi,
} from "@maple/domain/http"
import { Effect, Option } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { ApiKeysService } from "../services/ApiKeysService"
import { AuthService } from "../services/AuthService"
import { CliDeviceAuthService } from "../services/CliDeviceAuthService"
import { McpOAuthService } from "../services/McpOAuthService"

const bearerToken = (header: string | undefined) => {
	if (!header) return undefined
	const [scheme, token] = header.split(" ")
	return scheme?.toLowerCase() === "bearer" ? token : undefined
}

export const HttpAuthPublicLive = HttpApiBuilder.group(MapleApi, "authPublic", (handlers) =>
	Effect.gen(function* () {
		const authService = yield* AuthService
		const cliAuth = yield* CliDeviceAuthService
		return handlers
			.handle("login", ({ payload }) => authService.loginSelfHosted(payload.password))
			.handle("cliDeviceStart", ({ payload }) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					const requesterKey =
						request.headers["cf-connecting-ip"] ?? request.headers["x-forwarded-for"] ?? "unknown"
					return yield* cliAuth.start(payload.deviceName, requesterKey)
				}),
			)
			.handle("cliDevicePoll", ({ payload }) => cliAuth.poll(payload.deviceCode))
	}),
)

export const HttpAuthLive = HttpApiBuilder.group(MapleApi, "auth", (handlers) =>
	Effect.gen(function* () {
		const cliAuth = yield* CliDeviceAuthService
		const auth = yield* AuthService
		const apiKeys = yield* ApiKeysService
		const mcpOAuth = yield* McpOAuthService
		return handlers
			.handle("session", () => CurrentTenant.Context)
			.handle("cliDeviceInspect", ({ params }) => cliAuth.inspect(params.userCode))
			.handle("cliDeviceApprove", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const userEmail = yield* auth.getUserEmail(tenant.userId)
					return yield* cliAuth.approve(params.userCode, {
						orgId: tenant.orgId,
						userId: tenant.userId,
						roles: tenant.roles,
						userEmail,
					})
				}),
			)
			.handle("cliDeviceDeny", ({ params }) => cliAuth.deny(params.userCode))
			.handle("cliSessionRevoke", () =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					const resolved = yield* apiKeys
						.resolveByBearer(bearerToken(request.headers.authorization))
						.pipe(
							Effect.mapError(
								(error) => new CliDevicePersistenceError({ message: error.message }),
							),
						)
					if (Option.isNone(resolved) || !resolved.value.cliManaged) {
						return yield* new CliDeviceConflictError({
							message: "The active credential is not a browser-issued Maple CLI credential",
						})
					}
					yield* apiKeys
						.revoke(resolved.value.orgId, resolved.value.keyId)
						.pipe(
							Effect.mapError(
								(error) => new CliDevicePersistenceError({ message: error.message }),
							),
						)
					return new CliDeviceActionResponse({ status: "revoked" })
				}),
			)
			.handle("mcpOAuthAuthorizationInspect", ({ params }) => mcpOAuth.inspect(params.requestId))
			.handle("mcpOAuthAuthorizationApprove", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const userEmail = yield* auth.getUserEmail(tenant.userId)
					return yield* mcpOAuth.approve(params.requestId, {
						orgId: tenant.orgId,
						userId: tenant.userId,
						roles: tenant.roles,
						userEmail,
					})
				}),
			)
			.handle("mcpOAuthAuthorizationDeny", ({ params }) => mcpOAuth.deny(params.requestId))
	}),
)
