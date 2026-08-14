import type { AlertDestinationRow } from "@maple/db"
import { alertDestinations } from "@maple/db"
import {
	AlertDeliveryError,
	type AlertComparator,
	type AlertDestinationId,
	type AlertEventType,
	type AlertSeverity,
	type AlertSignalType,
	type OrgId,
} from "@maple/domain/http"
import { and, eq, inArray } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect"
import { buildAlertChatUrl } from "./AlertDeliveryDispatch"
import { dispatchDelivery as dispatchDeliveryImpl } from "./delivery/dispatch"
import type { DispatchContext } from "./delivery/context"
import {
	hydrateDestinationRow,
	type DestinationSecretConfig,
	type EnrichedDestinationSecretConfig,
} from "./AlertDestinationHydration"
import { parseBase64Aes256GcmKey } from "@/platform/Crypto"
import { SlackBotTokenResolver } from "@/services/integrations/slack-bot-token"
import { Database } from "@/platform/DatabaseLive"
import { EmailService } from "@/platform/EmailService"
import { Env } from "@/platform/Env"

/*
 * Shared notification dispatch for alert-adjacent features (error issues /
 * incidents). Best-effort side channel: failures are logged and swallowed.
 */

const DELIVERY_TIMEOUT_MS = 15_000
const NOTIFICATION_DELIVERY_CONCURRENCY = 5

class NotificationDispatchError extends Schema.TaggedError<NotificationDispatchError>()(
	"@maple/api/services/NotificationDispatchError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

export interface NotificationRequest {
	readonly deliveryKey: string
	readonly ruleId: string
	readonly ruleName: string
	readonly groupKey: string | null
	readonly signalType: AlertSignalType
	readonly severity: AlertSeverity
	readonly comparator: AlertComparator
	readonly threshold: number
	readonly thresholdUpper?: number | null
	readonly eventType: AlertEventType
	readonly incidentId: string | null
	readonly incidentStatus: string
	readonly dedupeKey: string
	readonly windowMinutes: number
	readonly value: number | null
	readonly sampleCount: number | null
	readonly linkUrl: string
	/**
	 * Triage-escalation extension: merged into the outbound JSON payload (and
	 * flips its eventType to "escalation") so a customer's agent/webhook gets
	 * the full triage context — severity, summary, suspected cause, evidence.
	 * Chat-style destinations still render from the alert-shaped fields above.
	 */
	readonly escalation?: Record<string, unknown>
}

export interface NotificationDispatcherShape {
	readonly dispatch: (
		orgId: OrgId,
		destinationIds: ReadonlyArray<AlertDestinationId>,
		context: NotificationRequest,
	) => Effect.Effect<{
		readonly delivered: number
		readonly failed: number
		readonly destinations: ReadonlyArray<NotificationDestinationResult>
	}>
}

export interface NotificationDestinationResult {
	readonly destinationId: AlertDestinationId
	readonly destinationName: string | null
	readonly status: "delivered" | "failed" | "disabled" | "missing"
	readonly error: string | null
}

/*
 * Hoisted out of the class options with an explicit annotation so the
 * `NotificationDispatcher.of(...)` return does not create a circular
 * inference through the class's own base expression.
 */
const make: Effect.Effect<
	NotificationDispatcherShape,
	NotificationDispatchError,
	Database | Env | EmailService | SlackBotTokenResolver
> = Effect.gen(function* () {
	const database = yield* Database
	const env = yield* Env
	const email = yield* EmailService
	const slackBotToken = yield* SlackBotTokenResolver

	const encryptionKey = yield* parseBase64Aes256GcmKey(
		Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
		(message) =>
			new NotificationDispatchError({
				message: `MAPLE_INGEST_KEY_ENCRYPTION_KEY: ${message}`,
			}),
	)

	const sendEmail = (to: string, subject: string, html: string) =>
		email
			.send(to, subject, html)
			.pipe(
				Effect.mapError(
					(error) => new AlertDeliveryError({ message: error.message, destinationType: "email" }),
				),
			)

	const enrichSecretConfig = (
		_row: AlertDestinationRow,
		secretConfig: DestinationSecretConfig,
	): Effect.Effect<EnrichedDestinationSecretConfig, NotificationDispatchError> =>
		// Hazel-OAuth webhooks now embed their delivery token in the URL path,
		// so no enrichment is required at dispatch time.
		Effect.succeed(secretConfig)

	const dispatchOne = Effect.fn("NotificationDispatcher.dispatchOne")(function* (
		row: AlertDestinationRow,
		request: NotificationRequest,
	) {
		yield* Effect.annotateCurrentSpan({
			"maple.destination.id": row.id,
			"maple.destination.type": row.type,
		})
		const hydrated = yield* hydrateDestinationRow(row, encryptionKey, {
			onPublicConfigInvalid: () =>
				new NotificationDispatchError({ message: "Stored destination config is invalid" }),
			onDecryptFailure: () =>
				new NotificationDispatchError({ message: "Failed to decrypt destination secret" }),
			onSecretConfigInvalid: () =>
				new NotificationDispatchError({ message: "Stored destination secret is invalid" }),
		})
		const enrichedSecret = yield* enrichSecretConfig(row, hydrated.secretConfig)
		const context: DispatchContext = {
			destination: row,
			publicConfig: hydrated.publicConfig,
			secretConfig: enrichedSecret,
			deliveryKey: request.deliveryKey,
			ruleId: request.ruleId,
			ruleName: request.ruleName,
			groupKey: request.groupKey,
			signalType: request.signalType,
			severity: request.severity,
			comparator: request.comparator,
			threshold: request.threshold,
			thresholdUpper: request.thresholdUpper ?? null,
			eventType: request.eventType,
			incidentId: request.incidentId,
			incidentStatus: request.incidentStatus,
			dedupeKey: request.dedupeKey,
			windowMinutes: request.windowMinutes,
			value: request.value,
			sampleCount: request.sampleCount,
		}
		const chatUrl = buildAlertChatUrl(env.MAPLE_APP_BASE_URL, {
			...request,
			thresholdUpper: request.thresholdUpper ?? null,
		})
		const payloadJson = JSON.stringify({
			eventType: request.escalation ? "escalation" : request.eventType,
			...(request.escalation ? { escalation: request.escalation } : {}),
			incidentId: request.incidentId,
			incidentStatus: request.incidentStatus,
			dedupeKey: request.dedupeKey,
			rule: {
				id: request.ruleId,
				name: request.ruleName,
				signalType: request.signalType,
				severity: request.severity,
				groupKey: request.groupKey,
				comparator: request.comparator,
				threshold: request.threshold,
				thresholdUpper: request.thresholdUpper ?? null,
				windowMinutes: request.windowMinutes,
			},
			observed: {
				value: request.value,
				sampleCount: request.sampleCount,
			},
			linkUrl: request.linkUrl,
			chatUrl,
			sentAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
		})
		const result = yield* dispatchDeliveryImpl(
			context,
			payloadJson,
			globalThis.fetch,
			DELIVERY_TIMEOUT_MS,
			request.linkUrl,
			chatUrl,
			{ sendEmail, resolveSlackBotToken: slackBotToken.resolve },
		).pipe(Effect.tapError(() => Effect.annotateCurrentSpan({ "maple.delivery.outcome": "failed" })))
		yield* Effect.annotateCurrentSpan({
			"maple.delivery.outcome": "delivered",
			...(result.responseCode != null ? { "http.response.status_code": result.responseCode } : {}),
		})
		return result
	})

	const dispatch: NotificationDispatcherShape["dispatch"] = Effect.fn("NotificationDispatcher.dispatch")(
		function* (
			orgId: OrgId,
			destinationIds: ReadonlyArray<AlertDestinationId>,
			context: NotificationRequest,
		) {
			if (destinationIds.length === 0) return { delivered: 0, failed: 0, destinations: [] }

			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(alertDestinations)
						.where(
							and(
								eq(alertDestinations.orgId, orgId),
								inArray(alertDestinations.id, [...destinationIds]),
							),
						),
				)
				.pipe(
					Effect.tapError((error) =>
						Effect.logError("NotificationDispatcher: failed to load destinations").pipe(
							Effect.annotateLogs({ orgId, message: error.message }),
						),
					),
					Effect.catchTag("@maple/api/lib/DatabaseError", () =>
						Effect.succeed<Array<AlertDestinationRow>>([]),
					),
				)

			const rowsById = new Map(rows.map((row) => [row.id, row]))
			const results = yield* Effect.forEach(
				destinationIds,
				(destinationId) => {
					const row = rowsById.get(destinationId)
					if (!row) {
						return Effect.succeed<NotificationDestinationResult>({
							destinationId,
							destinationName: null,
							status: "missing",
							error: "destination_missing",
						})
					}
					if (!row.enabled) {
						return Effect.succeed<NotificationDestinationResult>({
							destinationId,
							destinationName: row.name,
							status: "disabled",
							error: "destination_disabled",
						})
					}
					return dispatchOne(row, context).pipe(
						Effect.map(
							(): NotificationDestinationResult => ({
								destinationId: row.id,
								destinationName: row.name,
								status: "delivered",
								error: null,
							}),
						),
						Effect.tapError((error) =>
							Effect.logError("NotificationDispatcher: delivery failed").pipe(
								Effect.annotateLogs({
									orgId,
									destinationId: row.id,
									destinationType: row.type,
									message: error instanceof Error ? error.message : String(error),
								}),
							),
						),
						Effect.catchTags({
							"@maple/api/services/NotificationDispatchError": (error) =>
								Effect.succeed<NotificationDestinationResult>({
									destinationId: row.id,
									destinationName: row.name,
									status: "failed",
									error: error.message,
								}),
							"@maple/http/errors/AlertDeliveryError": (error) =>
								Effect.succeed<NotificationDestinationResult>({
									destinationId: row.id,
									destinationName: row.name,
									status: "failed",
									error: error.message,
								}),
						}),
					)
				},
				{ concurrency: NOTIFICATION_DELIVERY_CONCURRENCY },
			)

			return {
				delivered: results.filter((result) => result.status === "delivered").length,
				failed: results.filter((result) => result.status === "failed").length,
				destinations: results,
			}
		},
	)

	return NotificationDispatcher.of({ dispatch })
})

export class NotificationDispatcher extends Context.Service<
	NotificationDispatcher,
	NotificationDispatcherShape
>()("@maple/api/services/NotificationDispatcher", { make }) {
	// The resolver is self-provided (it needs only Database + Env, which every
	// caller already supplies) so wiring stays unchanged in app.ts and the
	// alerting worker.
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(SlackBotTokenResolver.layer))
}
