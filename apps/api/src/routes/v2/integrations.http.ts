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
	isoTimestampOrNull,
	notFound,
	permissionError,
	serviceUnavailable,
	upstreamError,
} from "@maple/domain/http/v2"
import { Array as Arr, Effect, Option } from "effect"
import { requireAdmin } from "../../lib/auth"
import { Env } from "../../lib/Env"
import type { SlackChannelSummary, SlackInstallStatus } from "../../services/SlackIntegrationService"
import { SLACK_CALLBACK_PATH, SlackIntegrationService } from "../../services/SlackIntegrationService"

/**
 * Best-effort origin of the incoming request. `x-forwarded-*` is client-supplied
 * on any path that does not strip it, so the result is NOT trusted on its own —
 * every security-relevant use must gate it through {@link isTrustedCallbackOrigin}.
 */
export const resolveRequestOrigin = (req: HttpServerRequest.HttpServerRequest): string => {
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

const hostnameOf = (url: string): string | null =>
	Option.match(Option.liftThrowable(() => new URL(url))(), {
		onNone: () => null,
		onSome: (parsed) => parsed.hostname.toLowerCase(),
	})

/** `app.maple.dev` → `maple.dev`; a single-label host is its own parent. */
const parentDomain = (hostname: string): string => {
	const dot = hostname.indexOf(".")
	return dot === -1 ? hostname : hostname.slice(dot + 1)
}

/**
 * Whether an origin may be used as the Slack OAuth callback origin.
 *
 * The callback URL is embedded in the authorize URL *and* persisted as
 * `oauth_auth_states.redirectUri`, then replayed as `redirect_uri` in the token
 * exchange — so an attacker-chosen origin mints an authorize URL pointing at a
 * host they control. `resolveRequestOrigin` reads `x-forwarded-host`, which any
 * client can set, so it is only accepted when it belongs to the same host family
 * as the trusted `MAPLE_APP_BASE_URL`:
 *
 *   - every deployed stage puts the web app and the API on sibling hosts under
 *     one registrable domain (`app.maple.dev` / `api.maple.dev`, `staging` /
 *     `api-staging`, `app-pr-<n>` / `api-pr-<n>`), and
 *   - local dev puts them on sibling `*.localhost` hosts (portless proxy) or on
 *     loopback ports.
 *
 * Anything else fails closed; Slack's registered-redirect allowlist is then a
 * second line of defense rather than the only one.
 */
export const isTrustedCallbackOrigin = (origin: string, appBaseUrl: string): boolean => {
	const host = hostnameOf(origin)
	const appHost = hostnameOf(appBaseUrl)
	if (host === null || appHost === null) return false
	if (host === appHost) return true
	// Local dev is one family: `*.localhost` (portless proxy) plus loopback IPs
	// (`bun dev:app`, which serves web and api on different loopback ports).
	const isLocal = (value: string) =>
		value === "localhost" || value.endsWith(".localhost") || value.startsWith("127.") || value === "[::1]"
	if (isLocal(host) || isLocal(appHost)) return isLocal(host) && isLocal(appHost)
	const parent = parentDomain(host)
	// Require a dot so a bare TLD (`evil.dev` vs `app.maple.dev`) never matches.
	return parent.includes(".") && parent === parentDomain(appHost)
}

const toStatus = (status: SlackInstallStatus): V2SlackIntegrationStatus => ({
	object: "slack_integration",
	installed: status.installed,
	team_id: status.teamId,
	team_name: status.teamName,
	bot_user_id: status.botUserId,
	installed_at: isoTimestampOrNull(status.installedAt),
})

const toChannelList = (channels: ReadonlyArray<SlackChannelSummary>): V2SlackChannelList => ({
	object: "slack_integration.channel_list",
	channels: Arr.map(channels, (channel) => ({
		id: channel.id,
		name: channel.name,
		is_private: channel.isPrivate,
		is_member: channel.isMember,
	})),
})

export const HttpV2SlackIntegrationsLive = HttpApiBuilder.group(MapleApiV2, "slackIntegration", (handlers) =>
	Effect.gen(function* () {
		const slack = yield* SlackIntegrationService
		const env = yield* Env

		return handlers
			.handle("status", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const status = yield* slack.getStatus(tenant.orgId).pipe(
						Effect.tapError((error) =>
							Effect.logError("Slack integration status failed", {
								tag: error._tag,
								message: error.message,
							}),
						),
						Effect.catchTags({
							"@maple/http/errors/IntegrationsPersistenceError": (error) =>
								Effect.fail(serviceUnavailable(error.message)),
						}),
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
					const origin = resolveRequestOrigin(req)
					if (!isTrustedCallbackOrigin(origin, env.MAPLE_APP_BASE_URL)) {
						yield* Effect.logError("Rejected Slack install: untrusted callback origin", {
							origin,
						})
						return yield* Effect.fail(
							serviceUnavailable("Slack installs are not available from this host"),
						)
					}
					const callbackUrl = `${origin}${SLACK_CALLBACK_PATH}`
					const result = yield* slack.startInstall(tenant.orgId, tenant.userId, callbackUrl).pipe(
						Effect.catchTags({
							"@maple/http/errors/IntegrationsValidationError": (error) =>
								Effect.fail(serviceUnavailable(error.message)),
							"@maple/http/errors/IntegrationsPersistenceError": (error) =>
								Effect.fail(serviceUnavailable(error.message)),
						}),
					)
					return {
						object: "slack_integration.install" as const,
						url: result.url,
					} satisfies V2SlackInstallResponse
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
						Effect.tapError((error) =>
							Effect.logError("Slack integration uninstall failed", {
								tag: error._tag,
								message: error.message,
							}),
						),
						Effect.catchTags({
							"@maple/http/errors/IntegrationsPersistenceError": (error) =>
								Effect.fail(serviceUnavailable(error.message)),
						}),
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
					// Admin-gated like install/uninstall: the list leaks the workspace's
					// channel inventory, including *private* channels the bot has been
					// invited to, which is not something every org member should be able
					// to enumerate. `status` deliberately stays ungated — the Slack
					// integration card renders install state for everyone.
					yield* requireAdmin(tenant.roles, () =>
						permissionError(
							"insufficient_permissions",
							"Only org admins can list Slack channels",
						),
					)
					const channels = yield* slack.listChannels(tenant.orgId).pipe(
						Effect.catchTags({
							"@maple/http/errors/IntegrationsNotConnectedError": (error) =>
								Effect.fail(notFound(error.message)),
							"@maple/http/errors/IntegrationsUpstreamError": (error) =>
								Effect.fail(upstreamError("slack_upstream_error", error.message)),
							"@maple/http/errors/IntegrationsPersistenceError": (error) =>
								Effect.fail(serviceUnavailable(error.message)),
						}),
					)
					return toChannelList(channels)
				}),
			)
	}),
)
