import {
	AlertDeliveryError,
	AlertValidationError,
	type AlertNotificationTemplate,
	type AlertIncidentId,
	type AlertRuleId,
} from "@maple/domain/http"
import type { AlertDestinationRow } from "@maple/db"
import { Effect } from "effect"
import { parseBase64Aes256GcmKey } from "@/platform/Crypto"
import type { EmailServiceShape } from "@/platform/EmailService"
import type { SlackBotTokenResolverShape } from "@/services/integrations/slack-bot-token"
import {
	buildAlertChatUrl,
	dispatchDelivery as dispatchDeliveryImpl,
	type DispatchContext as DeliveryDispatchContext,
	type DispatchResult,
} from "./AlertDeliveryDispatch"
import {
	hydrateDestinationRow,
	type DestinationSecretConfig,
	type EnrichedDestinationSecretConfig,
} from "./AlertDestinationHydration"
import type { AlertRuntimeShape } from "./AlertRuntime"

export type AlertDispatchContext = Omit<
	DeliveryDispatchContext,
	"ruleId" | "incidentId" | "incidentStatus" | "sentAtMs"
> & {
	readonly ruleId: AlertRuleId
	readonly incidentId: AlertIncidentId | null
	readonly incidentStatus: DeliveryDispatchContext["incidentStatus"]
	readonly linkUrl: string
	readonly sentAtMs: number
}

export type AlertDeliveryPayloadContext = Omit<
	AlertDispatchContext,
	"deliveryKey" | "destination" | "publicConfig" | "secretConfig"
>

export const parseAlertDestinationEncryptionKey = (
	raw: string,
): Effect.Effect<Buffer, AlertValidationError> =>
	parseBase64Aes256GcmKey(
		raw,
		(message) =>
			new AlertValidationError({
				message:
					message === "Expected a non-empty base64 encryption key"
						? "MAPLE_INGEST_KEY_ENCRYPTION_KEY is required"
						: message === "Expected base64 for exactly 32 bytes"
							? "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64 for exactly 32 bytes"
							: message,
				details: [],
			}),
	)

export const makeAlertDestinationDelivery = (options: {
	readonly encryptionKey: Buffer
	readonly appBaseUrl: string
	readonly runtime: AlertRuntimeShape
	readonly email: EmailServiceShape
	readonly resolveSlackBotToken: SlackBotTokenResolverShape["resolve"]
}) => {
	const hydrateDestination = Effect.fn("AlertsService.hydrateDestination")(function* (
		row: AlertDestinationRow,
	) {
		const { publicConfig, secretConfig } = yield* hydrateDestinationRow(row, options.encryptionKey, {
			onPublicConfigInvalid: (cause) =>
				new AlertValidationError({
					message: "Stored destination config is invalid",
					details: [],
					cause,
				}),
			onDecryptFailure: () =>
				new AlertValidationError({
					message: "Failed to decrypt destination secret",
					details: [],
				}),
			onSecretConfigInvalid: (cause) =>
				new AlertValidationError({
					message: "Stored destination secret is invalid",
					details: [],
					cause,
				}),
		})
		return { row, publicConfig, secretConfig } as const
	})

	const enrichSecretForDispatch = (
		_row: AlertDestinationRow,
		secretConfig: DestinationSecretConfig,
	): Effect.Effect<EnrichedDestinationSecretConfig, AlertDeliveryError> =>
		// Hazel-OAuth webhooks embed their delivery token in the URL path, so
		// there's nothing to enrich at dispatch time.
		Effect.succeed(secretConfig)

	const composeLinkUrl = (serviceLinkName: string | null) =>
		serviceLinkName
			? `${options.appBaseUrl}/services/${encodeURIComponent(serviceLinkName)}`
			: `${options.appBaseUrl}/alerts`

	const composeChatUrl = (context: AlertDispatchContext): string =>
		buildAlertChatUrl(options.appBaseUrl, context)

	const sendEmail = (to: string, subject: string, html: string) =>
		options.email
			.send(to, subject, html)
			.pipe(
				Effect.mapError(
					(error) => new AlertDeliveryError({ message: error.message, destinationType: "email" }),
				),
			)

	const dispatchDelivery = (
		context: AlertDispatchContext,
		payloadJson: string,
	): Effect.Effect<DispatchResult, AlertDeliveryError> =>
		dispatchDeliveryImpl(
			context,
			payloadJson,
			options.runtime.fetch,
			options.runtime.deliveryTimeoutMs(),
			context.linkUrl,
			composeChatUrl(context),
			{ sendEmail, resolveSlackBotToken: options.resolveSlackBotToken },
		)

	const buildPayload = (context: AlertDeliveryPayloadContext) =>
		({
			eventType: context.eventType,
			incidentId: context.incidentId,
			incidentStatus: context.incidentStatus,
			dedupeKey: context.dedupeKey,
			rule: {
				id: context.ruleId,
				name: context.ruleName,
				signalType: context.signalType,
				severity: context.severity,
				groupKey: context.groupKey,
				comparator: context.comparator,
				threshold: context.threshold,
				thresholdUpper: context.thresholdUpper,
				windowMinutes: context.windowMinutes,
			},
			observed: {
				value: context.value,
				sampleCount: context.sampleCount,
			},
			template: context.template ?? null,
			linkUrl: context.linkUrl,
			chatUrl: buildAlertChatUrl(options.appBaseUrl, context),
			sentAt: new Date(context.sentAtMs).toISOString(),
		}) satisfies {
			readonly eventType: AlertDeliveryPayloadContext["eventType"]
			readonly incidentId: AlertIncidentId | null
			readonly incidentStatus: AlertDeliveryPayloadContext["incidentStatus"]
			readonly dedupeKey: string
			readonly rule: Record<string, unknown>
			readonly observed: Record<string, unknown>
			readonly template: AlertNotificationTemplate | null
			readonly linkUrl: string
			readonly chatUrl: string
			readonly sentAt: string
		}

	const sendImmediateNotification = Effect.fn("AlertsService.sendImmediateNotification")(function* (
		destinationRow: AlertDestinationRow,
		context: Omit<AlertDispatchContext, "destination" | "publicConfig" | "secretConfig">,
	) {
		const hydrated = yield* hydrateDestination(destinationRow)
		const enrichedSecret = yield* enrichSecretForDispatch(hydrated.row, hydrated.secretConfig)
		const fullContext: AlertDispatchContext = {
			destination: hydrated.row,
			publicConfig: hydrated.publicConfig,
			secretConfig: enrichedSecret,
			...context,
		}
		const payload = buildPayload(fullContext)
		return yield* dispatchDelivery(fullContext, JSON.stringify(payload))
	})

	return {
		hydrateDestination,
		enrichSecretForDispatch,
		composeLinkUrl,
		dispatchDelivery,
		buildPayload,
		sendImmediateNotification,
	} as const
}
