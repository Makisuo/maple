import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant } from "@maple/domain/http"
import type {
	V2SlackChannelList,
	V2SlackIntegrationStatus,
	V2SlackInstallResponse,
	V2SlackUninstallResponse,
} from "@maple/domain/http/v2"
import {
	MapleApiV2,
	notFound,
	permissionError,
	serviceUnavailable,
	upstreamError,
} from "@maple/domain/http/v2"
import { Effect, Option } from "effect"
import { requireAdmin } from "../../lib/auth"
import type { SlackChannelSummary, SlackInstallStatus } from "../../services/SlackIntegrationService"
import { SLACK_CALLBACK_PATH, SlackIntegrationService } from "../../services/SlackIntegrationService"

const resolveRequestOrigin = (req: HttpServerRequest.HttpServerRequest): string => {
	const headers = req.headers as Record<string, string | undefined>
	const forwardedHost = headers["x-forwarded-host"]
	const forwardedProto = headers["x-forwarded-proto"]
	const host = forwardedHost ?? headers.host
	if (host) {
		const proto =
			forwardedProto ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https")
		return `${proto}://${host}`
	}
	return Option.match(Option.liftThrowable(() => new URL(req.url))(), {
		onNone: () => "",
		onSome: (parsed) => `${parsed.protocol}//${parsed.host}`,
	})
}

const toStatus = (status: SlackInstallStatus): V2SlackIntegrationStatus => ({
	object: "slack_integration",
	installed: status.installed,
	team_id: status.teamId,
	team_name: status.teamName,
	bot_user_id: status.botUserId,
	installed_at: status.installedAt != null ? new Date(status.installedAt).toISOString() : null,
})

const toChannelList = (channels: ReadonlyArray<SlackChannelSummary>): V2SlackChannelList => ({
	object: "slack_integration.channel_list",
	channels: channels.map((channel) => ({
		id: channel.id,
		name: channel.name,
		is_private: channel.isPrivate,
		is_member: channel.isMember,
	})),
})

export const HttpV2SlackIntegrationsLive = HttpApiBuilder.group(MapleApiV2, "slackIntegration", (handlers) =>
	Effect.gen(function* () {
		const slack = yield* SlackIntegrationService

		return handlers
			.handle("status", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const status = yield* slack.getStatus(tenant.orgId).pipe(
						Effect.mapError(() => serviceUnavailable("Slack integration status is unavailable")),
					)
					return toStatus(status)
				}),
			)
			.handle("install", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, () =>
						permissionError(
							"insufficient_permissions",
							"Only org admins can install the Slack app",
						),
					)
					const req = yield* HttpServerRequest.HttpServerRequest
					const callbackUrl = `${resolveRequestOrigin(req)}${SLACK_CALLBACK_PATH}`
					const result = yield* slack
						.startInstall(tenant.orgId, tenant.userId, callbackUrl)
						.pipe(
							Effect.catchTags({
								"@maple/http/errors/IntegrationsValidationError": (error) =>
									Effect.fail(serviceUnavailable(error.message)),
								"@maple/http/errors/IntegrationsPersistenceError": (error) =>
									Effect.fail(serviceUnavailable(error.message)),
							}),
						)
					return { object: "slack_integration.install" as const, url: result.url } satisfies V2SlackInstallResponse
				}),
			)
			.handle("uninstall", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, () =>
						permissionError(
							"insufficient_permissions",
							"Only org admins can uninstall the Slack app",
						),
					)
					yield* slack.uninstall(tenant.orgId).pipe(
						Effect.mapError(() => serviceUnavailable("Failed to uninstall the Slack app")),
					)
					return {
						object: "slack_integration" as const,
						installed: false as const,
					} satisfies V2SlackUninstallResponse
				}),
			)
			.handle("channels", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const channels = yield* slack.listChannels(tenant.orgId).pipe(
						Effect.catchTags({
							"@maple/http/errors/IntegrationsNotConnectedError": (error) =>
								Effect.fail(notFound(error.message)),
							"@maple/http/errors/IntegrationsUpstreamError": (error) =>
								Effect.fail(upstreamError("slack_upstream_error", error.message)),
							"@maple/http/errors/IntegrationsValidationError": (error) =>
								Effect.fail(serviceUnavailable(error.message)),
							"@maple/http/errors/IntegrationsPersistenceError": (error) =>
								Effect.fail(serviceUnavailable(error.message)),
						}),
					)
					return toChannelList(channels)
				}),
			)
	}),
)
