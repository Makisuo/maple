import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { AlertDestinationDocument, AlertDestinationUpdateRequest } from "@maple/domain/http"
import {
	CurrentTenant,
	DiscordAlertDestinationConfig,
	EmailAlertDestinationConfig,
	HazelAlertDestinationConfig,
	HazelOAuthAlertDestinationConfig,
	PagerDutyAlertDestinationConfig,
	SlackAlertDestinationConfig,
	WebhookAlertDestinationConfig,
} from "@maple/domain/http"
import type {
	V2AlertDestination,
	V2AlertDestinationCreateParams,
	V2AlertDestinationMutationResponse,
	V2AlertDestinationUpdateParams,
} from "@maple/domain/http/v2"
import { MapleApiV2, paginateArray, resourceNotFound } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { AlertsService } from "../../services/AlertsService"
import { mapAlertError } from "./alerts-error-map"

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
	...(doc.txid !== undefined ? { txid: doc.txid } : {}),
})

const toCreateRequest = (params: V2AlertDestinationCreateParams) => {
	switch (params.type) {
		case "slack":
			return new SlackAlertDestinationConfig({
				type: "slack",
				name: params.name,
				webhookUrl: params.webhook_url,
				...(params.channel_label !== undefined ? { channelLabel: params.channel_label } : {}),
				...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
			})
		case "pagerduty":
			return new PagerDutyAlertDestinationConfig({
				type: "pagerduty",
				name: params.name,
				integrationKey: params.integration_key,
				...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
			})
		case "webhook":
			return new WebhookAlertDestinationConfig({
				type: "webhook",
				name: params.name,
				url: params.url,
				...(params.signing_secret !== undefined ? { signingSecret: params.signing_secret } : {}),
				...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
			})
		case "hazel":
			return new HazelAlertDestinationConfig({
				type: "hazel",
				name: params.name,
				webhookUrl: params.webhook_url,
				...(params.signing_secret !== undefined ? { signingSecret: params.signing_secret } : {}),
				...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
			})
		case "hazel-oauth":
			return new HazelOAuthAlertDestinationConfig({
				type: "hazel-oauth",
				name: params.name,
				hazelOrganizationId: params.hazel_organization_id,
				hazelOrganizationName: params.hazel_organization_name,
				...(params.hazel_organization_logo_url !== undefined
					? { hazelOrganizationLogoUrl: params.hazel_organization_logo_url }
					: {}),
				hazelChannelId: params.hazel_channel_id,
				hazelChannelName: params.hazel_channel_name,
				...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
			})
		case "discord":
			return new DiscordAlertDestinationConfig({
				type: "discord",
				name: params.name,
				webhookUrl: params.webhook_url,
				...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
			})
		case "email":
			return new EmailAlertDestinationConfig({
				type: "email",
				name: params.name,
				memberUserIds: params.member_user_ids,
				...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
			})
	}
}

const toUpdateRequest = (params: V2AlertDestinationUpdateParams): AlertDestinationUpdateRequest => {
	const shared = {
		...(params.name !== undefined ? { name: params.name } : {}),
		...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
	}
	switch (params.type) {
		case "slack":
			return {
				type: "slack",
				...shared,
				...(params.webhook_url !== undefined ? { webhookUrl: params.webhook_url } : {}),
				...(params.channel_label !== undefined ? { channelLabel: params.channel_label } : {}),
			}
		case "pagerduty":
			return {
				type: "pagerduty",
				...shared,
				...(params.integration_key !== undefined ? { integrationKey: params.integration_key } : {}),
			}
		case "webhook":
			return {
				type: "webhook",
				...shared,
				...(params.url !== undefined ? { url: params.url } : {}),
				...(params.signing_secret !== undefined ? { signingSecret: params.signing_secret } : {}),
			}
		case "hazel":
			return {
				type: "hazel",
				...shared,
				...(params.webhook_url !== undefined ? { webhookUrl: params.webhook_url } : {}),
				...(params.signing_secret !== undefined ? { signingSecret: params.signing_secret } : {}),
			}
		case "hazel-oauth":
			return {
				type: "hazel-oauth",
				...shared,
				...(params.hazel_organization_id !== undefined
					? { hazelOrganizationId: params.hazel_organization_id }
					: {}),
				...(params.hazel_organization_name !== undefined
					? { hazelOrganizationName: params.hazel_organization_name }
					: {}),
				...(params.hazel_organization_logo_url !== undefined
					? { hazelOrganizationLogoUrl: params.hazel_organization_logo_url }
					: {}),
				...(params.hazel_channel_id !== undefined ? { hazelChannelId: params.hazel_channel_id } : {}),
				...(params.hazel_channel_name !== undefined
					? { hazelChannelName: params.hazel_channel_name }
					: {}),
			}
		case "discord":
			return {
				type: "discord",
				...shared,
				...(params.webhook_url !== undefined ? { webhookUrl: params.webhook_url } : {}),
			}
		case "email":
			return {
				type: "email",
				...shared,
				...(params.member_user_ids !== undefined ? { memberUserIds: params.member_user_ids } : {}),
			}
	}
}

export const HttpV2AlertDestinationsLive = HttpApiBuilder.group(MapleApiV2, "alertDestinations", (handlers) =>
	Effect.gen(function* () {
		const alerts = yield* AlertsService

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const response = yield* alerts
						.listDestinations(tenant.orgId)
						.pipe(mapAlertError("destination_list"))
					const page = yield* paginateArray(response.destinations.map(toV2Destination), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const response = yield* alerts
						.listDestinations(tenant.orgId)
						.pipe(mapAlertError("destination_list"))
					const destination = response.destinations.find((doc) => doc.id === params.id)
					if (destination === undefined)
						return yield* Effect.fail(
							resourceNotFound("alert_destination", "No such alert destination."),
						)
					return toV2Destination(destination)
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const created = yield* alerts
						.createDestination(
							tenant.orgId,
							tenant.userId,
							tenant.roles,
							toCreateRequest(payload),
						)
						.pipe(mapAlertError("destination_create"))
					return toV2DestinationMutation(created)
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const updated = yield* alerts
						.updateDestination(
							tenant.orgId,
							tenant.userId,
							tenant.roles,
							params.id,
							toUpdateRequest(payload),
						)
						.pipe(mapAlertError("destination_update"))
					return toV2DestinationMutation(updated)
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const deleted = yield* alerts
						.deleteDestination(tenant.orgId, tenant.roles, params.id)
						.pipe(mapAlertError("destination_delete"))
					return {
						id: deleted.id,
						object: "alert_destination" as const,
						deleted: true as const,
						...(deleted.txid !== undefined ? { txid: deleted.txid } : {}),
					}
				}),
			)
			.handle("test", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const result = yield* alerts
						.testDestination(tenant.orgId, tenant.userId, tenant.roles, params.id)
						.pipe(mapAlertError("destination_test"))
					return {
						object: "alert_destination.test_result" as const,
						success: result.success,
						message: result.message,
					}
				}),
			)
	}),
)
