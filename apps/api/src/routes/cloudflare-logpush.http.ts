import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CloudflareLogpushForbiddenError, CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { CloudflareLogpushService } from "../services/CloudflareLogpushService"
import { requireAdmin } from "../lib/auth"

const forbidden = (message: string) => () => new CloudflareLogpushForbiddenError({ message })

export const HttpCloudflareLogpushLive = HttpApiBuilder.group(MapleApi, "cloudflareLogpush", (handlers) =>
	Effect.gen(function* () {
		const service = yield* CloudflareLogpushService

		return handlers
			.handle("list", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* service.list(tenant.orgId)
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(
						tenant.roles,
						forbidden("Only org admins can create Cloudflare Logpush connectors"),
					)
					return yield* service.create(tenant.orgId, tenant.userId, payload)
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(
						tenant.roles,
						forbidden("Only org admins can update Cloudflare Logpush connectors"),
					)
					return yield* service.update(tenant.orgId, params.connectorId, tenant.userId, payload)
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(
						tenant.roles,
						forbidden("Only org admins can delete Cloudflare Logpush connectors"),
					)
					return yield* service.delete(tenant.orgId, params.connectorId)
				}),
			)
			.handle("getSetup", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(
						tenant.roles,
						forbidden("Only org admins can view Cloudflare Logpush setup details"),
					)
					return yield* service.getSetup(tenant.orgId, params.connectorId)
				}),
			)
			.handle("rotateSecret", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(
						tenant.roles,
						forbidden("Only org admins can rotate Cloudflare Logpush secrets"),
					)
					return yield* service.rotateSecret(tenant.orgId, params.connectorId, tenant.userId)
				}),
			)
	}),
)
