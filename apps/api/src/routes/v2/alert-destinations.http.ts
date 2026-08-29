import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { AlertDestinationDocument, AlertDestinationUpdateRequest, AuditChanges } from "@maple/domain/http"
import {
	CurrentTenant,
	DiscordAlertDestinationConfig,
	EmailAlertDestinationConfig,
	HazelOAuthAlertDestinationConfig,
	AlertDestinationNotFoundError,
	PagerDutyAlertDestinationConfig,
	SlackBotAlertDestinationConfig,
	TelegramAlertDestinationConfig,
	WebhookAlertDestinationConfig,
} from "@maple/domain/http"
import type {
	V2AlertDestination,
	V2AlertDestinationCreateParams,
	V2AlertDestinationMutationResponse,
	V2AlertDestinationUpdateParams,
	V2TelegramChatList,
} from "@maple/domain/http/v2"
import { MapleApiV2, paginateArray } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { recordHttpAudit } from "@/services/audit/AuditLogService"
import { AlertDestinationsService } from "@/services/alerts/AlertDestinationsService"

const toV2Destination = (doc: AlertDestinationDocument): V2AlertDestination => ({
	id: doc.id,
	object: "alert_destination",
	name: doc.name,
	type: doc.type,
	enabled: doc.enabled,
	summary: doc.summary,
	channel_label: doc.channelLabel,
	member_user_ids: doc.memberUserIds,
	last_tested_at: doc.lastTestedAt,
	last_test_error: doc.lastTestError,
	created_at: doc.createdAt,
	updated_at: doc.updatedAt,
})

const toV2DestinationMutation = (doc: AlertDestinationDocument): V2AlertDestinationMutationResponse => ({
	...toV2Destination(doc),
	...(doc.txid !== undefined ? { txid: doc.txid } : undefined),
})

const toCreateRequest = (params: V2AlertDestinationCreateParams) => {
	switch (params.type) {
		case "slack-bot":
			return new SlackBotAlertDestinationConfig({
				type: "slack-bot",
				name: params.name,
				channelId: params.channel_id,
				...(params.channel_name !== undefined ? { channelName: params.channel_name } : undefined),
				...(params.enabled !== undefined ? { enabled: params.enabled } : undefined),
			})
		case "pagerduty":
			return new PagerDutyAlertDestinationConfig({
				type: "pagerduty",
				name: params.name,
				integrationKey: params.integration_key,
				...(params.enabled !== undefined ? { enabled: params.enabled } : undefined),
			})
		case "webhook":
			return new WebhookAlertDestinationConfig({
				type: "webhook",
				name: params.name,
				url: params.url,
				...(params.signing_secret !== undefined
					? { signingSecret: params.signing_secret }
					: undefined),
				...(params.enabled !== undefined ? { enabled: params.enabled } : undefined),
			})
		case "hazel-oauth":
			return new HazelOAuthAlertDestinationConfig({
				type: "hazel-oauth",
				name: params.name,
				hazelOrganizationId: params.hazel_organization_id,
				hazelOrganizationName: params.hazel_organization_name,
				...(params.hazel_organization_logo_url !== undefined
					? {
							hazelOrganizationLogoUrl: params.hazel_organization_logo_url,
						}
					: undefined),
				hazelChannelId: params.hazel_channel_id,
				hazelChannelName: params.hazel_channel_name,
				...(params.enabled !== undefined ? { enabled: params.enabled } : undefined),
			})
		case "discord":
			return new DiscordAlertDestinationConfig({
				type: "discord",
				name: params.name,
				webhookUrl: params.webhook_url,
				...(params.enabled !== undefined ? { enabled: params.enabled } : undefined),
			})
		case "telegram":
			return new TelegramAlertDestinationConfig({
				type: "telegram",
				name: params.name,
				botToken: params.bot_token,
				chatId: params.chat_id,
				...(params.enabled !== undefined ? { enabled: params.enabled } : undefined),
			})
		case "email":
			return new EmailAlertDestinationConfig({
				type: "email",
				name: params.name,
				memberUserIds: params.member_user_ids,
				...(params.enabled !== undefined ? { enabled: params.enabled } : undefined),
			})
	}
}

const toUpdateRequest = (params: V2AlertDestinationUpdateParams): AlertDestinationUpdateRequest => {
	const shared = {
		...(params.name !== undefined ? { name: params.name } : undefined),
		...(params.enabled !== undefined ? { enabled: params.enabled } : undefined),
	}
	switch (params.type) {
		case "slack-bot":
			return {
				type: "slack-bot",
				...shared,
				...(params.channel_id !== undefined ? { channelId: params.channel_id } : undefined),
				...(params.channel_name !== undefined ? { channelName: params.channel_name } : undefined),
			}
		case "pagerduty":
			return {
				type: "pagerduty",
				...shared,
				...(params.integration_key !== undefined
					? { integrationKey: params.integration_key }
					: undefined),
			}
		case "webhook":
			return {
				type: "webhook",
				...shared,
				...(params.url !== undefined ? { url: params.url } : undefined),
				...(params.signing_secret !== undefined
					? { signingSecret: params.signing_secret }
					: undefined),
			}
		case "hazel-oauth":
			return {
				type: "hazel-oauth",
				...shared,
				...(params.hazel_organization_id !== undefined
					? {
							hazelOrganizationId: params.hazel_organization_id,
						}
					: undefined),
				...(params.hazel_organization_name !== undefined
					? {
							hazelOrganizationName: params.hazel_organization_name,
						}
					: undefined),
				...(params.hazel_organization_logo_url !== undefined
					? {
							hazelOrganizationLogoUrl: params.hazel_organization_logo_url,
						}
					: undefined),
				...(params.hazel_channel_id !== undefined
					? { hazelChannelId: params.hazel_channel_id }
					: undefined),
				...(params.hazel_channel_name !== undefined
					? {
							hazelChannelName: params.hazel_channel_name,
						}
					: undefined),
			}
		case "discord":
			return {
				type: "discord",
				...shared,
				...(params.webhook_url !== undefined ? { webhookUrl: params.webhook_url } : undefined),
			}
		case "telegram":
			return {
				type: "telegram",
				...shared,
				...(params.bot_token !== undefined ? { botToken: params.bot_token } : undefined),
				...(params.chat_id !== undefined ? { chatId: params.chat_id } : undefined),
			}
		case "email":
			return {
				type: "email",
				...shared,
				...(params.member_user_ids !== undefined
					? { memberUserIds: params.member_user_ids }
					: undefined),
			}
	}
}

/** Credential-bearing config keys; their values must never reach the audit row. */
const destinationSecretKeys = new Set(["integrationKey", "signingSecret", "url", "webhookUrl", "botToken"])

/** Fields of an update that are readable back off the destination document. */
const destinationObservableValue = (
	doc: AlertDestinationDocument,
	key: string,
): string | boolean | ReadonlyArray<string> | null | undefined => {
	switch (key) {
		case "name":
			return doc.name
		case "enabled":
			return doc.enabled
		case "memberUserIds":
			return doc.memberUserIds
		default:
			return undefined
	}
}

/**
 * Diff an update against the pre/post documents. Secrets are recorded as
 * `<redacted>`; config knobs the wire doc doesn't echo (channel ids, chat ids)
 * are recorded as touched with `<updated>` placeholders.
 */
const buildDestinationChanges = (
	request: AlertDestinationUpdateRequest,
	before: AlertDestinationDocument | undefined,
	after: AlertDestinationDocument,
): AuditChanges | undefined => {
	const fields: string[] = []
	const beforeOut: Record<string, unknown> = {}
	const afterOut: Record<string, unknown> = {}
	for (const key of Object.keys(request)) {
		if (key === "type") continue
		const wireName = key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)
		if (destinationSecretKeys.has(key)) {
			fields.push(wireName)
			beforeOut[wireName] = "<redacted>"
			afterOut[wireName] = "<redacted>"
			continue
		}
		const prev = before === undefined ? undefined : destinationObservableValue(before, key)
		const next = destinationObservableValue(after, key)
		if (prev === undefined && next === undefined) {
			fields.push(wireName)
			beforeOut[wireName] = "<updated>"
			afterOut[wireName] = "<updated>"
			continue
		}
		if (JSON.stringify(prev) === JSON.stringify(next)) continue
		fields.push(wireName)
		beforeOut[wireName] = prev
		afterOut[wireName] = next
	}
	return fields.length === 0 ? undefined : { fields, before: beforeOut, after: afterOut }
}

export const HttpV2AlertDestinationsLive = HttpApiBuilder.group(MapleApiV2, "alertDestinations", (handlers) =>
	Effect.gen(function* () {
		const destinations = yield* AlertDestinationsService

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const response = yield* destinations.listDestinations(tenant.orgId)

					const page = yield* paginateArray(response.destinations.map(toV2Destination), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const response = yield* destinations.listDestinations(tenant.orgId)

					const destination = response.destinations.find((doc) => doc.id === params.id)
					if (destination === undefined)
						return yield* Effect.fail(
							new AlertDestinationNotFoundError({
								message: "No such alert destination.",
								destinationId: params.id,
							}),
						)
					return toV2Destination(destination)
				}),
			)
			.handle("telegramChats", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const chats = yield* destinations.listTelegramChats(tenant.roles, payload.bot_token)
					return {
						object: "alert_destination.telegram_chat_list" as const,
						chats,
					} satisfies V2TelegramChatList
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const created = yield* destinations.createDestination(
						tenant.orgId,
						tenant.userId,
						tenant.roles,
						toCreateRequest(payload),
					)

					yield* recordHttpAudit("alert_destination.created", {
						resourceId: created.id,
						metadata: { name: created.name, type: created.type },
					})

					return toV2DestinationMutation(created)
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const request = toUpdateRequest(payload)
					const existing = yield* destinations.listDestinations(tenant.orgId)
					const current = existing.destinations.find((doc) => doc.id === params.id)
					const updated = yield* destinations.updateDestination(
						tenant.orgId,
						tenant.userId,
						tenant.roles,
						params.id,
						request,
					)

					const changes = buildDestinationChanges(request, current, updated)
					yield* recordHttpAudit("alert_destination.updated", {
						resourceId: updated.id,
						changes,
						metadata: { name: updated.name, type: updated.type },
					})

					return toV2DestinationMutation(updated)
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const deleted = yield* destinations.deleteDestination(
						tenant.orgId,
						tenant.roles,
						params.id,
					)
					yield* recordHttpAudit("alert_destination.deleted", {
						resourceId: deleted.id,
					})

					return {
						id: deleted.id,
						object: "alert_destination" as const,
						deleted: true as const,
						...(deleted.txid !== undefined ? { txid: deleted.txid } : undefined),
					}
				}),
			)
			.handle("test", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const result = yield* destinations.testDestination(
						tenant.orgId,
						tenant.userId,
						tenant.roles,
						params.id,
					)

					return {
						object: "alert_destination.test_result" as const,
						success: result.success,
						message: result.message,
					}
				}),
			)
	}),
)
