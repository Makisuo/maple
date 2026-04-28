import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { AuthService } from "../services/AuthService"

export const HttpAuthPublicLive = HttpApiBuilder.group(MapleApi, "authPublic", (handlers) =>
	Effect.gen(function* () {
		const authService = yield* AuthService
		return handlers.handle("login", ({ payload }) => authService.loginSelfHosted(payload.password))
	}),
)

export const HttpAuthLive = HttpApiBuilder.group(MapleApi, "auth", (handlers) =>
	Effect.gen(function* () {
		return handlers.handle("session", () =>
			Effect.gen(function* () {
				return yield* CurrentTenant.Context
			}),
		)
	}),
)
