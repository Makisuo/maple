import { timingSafeEqual } from "node:crypto"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import {
	MapleApi,
	SelfManagedCollectorRepublishError,
	SelfManagedCollectorRepublishResponse,
	SelfManagedCollectorUnauthorizedError,
} from "@maple/domain/http"
import { Effect, Option, Redacted } from "effect"
import { Env } from "../services/Env"
import { SelfManagedCollectorConfigService } from "../services/SelfManagedCollectorConfigService"

export const HttpSelfManagedCollectorLive = HttpApiBuilder.group(
	MapleApi,
	"selfManagedCollector",
	(handlers) =>
		Effect.gen(function* () {
			const env = yield* Env
			const collectorConfig = yield* SelfManagedCollectorConfigService

			return handlers.handle("republish", () =>
				Effect.gen(function* () {
					const internalToken = Option.match(env.INTERNAL_SERVICE_TOKEN, {
						onNone: () => undefined,
						onSome: Redacted.value,
					})

					if (!internalToken) {
						return yield* Effect.fail(
							new SelfManagedCollectorUnauthorizedError({
								message: "Republish endpoint not configured (INTERNAL_SERVICE_TOKEN missing)",
							}),
						)
					}

					const req = yield* HttpServerRequest.HttpServerRequest
					const authHeader = req.headers.authorization ?? ""
					const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : ""

					const isValid =
						provided.length === internalToken.length &&
						timingSafeEqual(Buffer.from(provided), Buffer.from(internalToken))

					if (!isValid) {
						return yield* Effect.fail(
							new SelfManagedCollectorUnauthorizedError({ message: "Unauthorized" }),
						)
					}

					const result = yield* collectorConfig.publishConfig().pipe(
						Effect.mapError(
							(error) =>
								new SelfManagedCollectorRepublishError({
									message: error.message,
								}),
						),
					)

					return new SelfManagedCollectorRepublishResponse({
						published: result.published,
						orgCount: result.orgCount,
					})
				}),
			)
		}),
)
