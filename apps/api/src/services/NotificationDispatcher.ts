import type { AlertDestinationRow } from "@maple/db"
import { alertDestinations } from "@maple/db"
import {
	type AlertComparator,
	type AlertDestinationId,
	type AlertEventType,
	type AlertSeverity,
	type AlertSignalType,
	type OrgId,
} from "@maple/domain/http"
import { and, eq, inArray } from "drizzle-orm"
import { Context, Effect, Layer, Redacted } from "effect"
import {
	buildAlertChatUrl,
	dispatchDelivery as dispatchDeliveryImpl,
	type DispatchContext,
} from "./AlertDeliveryDispatch"
import {
	hydrateDestinationRow,
	type DestinationSecretConfig,
	type EnrichedDestinationSecretConfig,
} from "./AlertDestinationHydration"
import { parseBase64Aes256GcmKey } from "./Crypto"
import { Database } from "./DatabaseLive"
import { Env } from "./Env"

/*
 * Shared notification dispatch for alert-adjacent features (error issues /
 * incidents). Best-effort side channel: failures are logged and swallowed.
 */

const DELIVERY_TIMEOUT_MS = 15_000

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
}

export interface NotificationDispatcherShape {
	readonly dispatch: (
		orgId: OrgId,
		destinationIds: ReadonlyArray<AlertDestinationId>,
		context: NotificationRequest,
	) => Effect.Effect<{ readonly delivered: number; readonly failed: number }>
}

export class NotificationDispatcher extends Context.Service<
	NotificationDispatcher,
	NotificationDispatcherShape
>()("NotificationDispatcher", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env

		const encryptionKey = yield* parseBase64Aes256GcmKey(
			Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			(message) => new Error(message),
		)

		const enrichSecretConfig = (
			_row: AlertDestinationRow,
			secretConfig: DestinationSecretConfig,
		): Effect.Effect<EnrichedDestinationSecretConfig, Error> =>
			// Hazel-OAuth webhooks now embed their delivery token in the URL path,
			// so no enrichment is required at dispatch time.
			Effect.succeed(secretConfig)

		const dispatchOne = (row: AlertDestinationRow, request: NotificationRequest) =>
			Effect.gen(function* () {
				const hydrated = yield* hydrateDestinationRow(row, encryptionKey, {
					onPublicConfigInvalid: () => new Error("Stored destination config is invalid"),
					onDecryptFailure: () => new Error("Failed to decrypt destination secret"),
					onSecretConfigInvalid: () => new Error("Stored destination secret is invalid"),
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
					eventType: request.eventType,
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
					sentAt: new Date().toISOString(),
				})
				return yield* dispatchDeliveryImpl(
					context,
					payloadJson,
					globalThis.fetch,
					DELIVERY_TIMEOUT_MS,
					request.linkUrl,
					chatUrl,
				)
			})

		const dispatch: NotificationDispatcherShape["dispatch"] = (orgId, destinationIds, context) =>
			Effect.gen(function* () {
				if (destinationIds.length === 0) return { delivered: 0, failed: 0 }

				const rows = yield* database
					.execute((db) =>
						db
							.select()
							.from(alertDestinations)
							.where(
								and(
									eq(alertDestinations.orgId, orgId),
									inArray(alertDestinations.id, destinationIds as ReadonlyArray<string>),
								),
							),
					)
					.pipe(
						Effect.tapError((error) =>
							Effect.logError("NotificationDispatcher: failed to load destinations").pipe(
								Effect.annotateLogs({ orgId, message: error.message }),
							),
						),
						Effect.catch(() => Effect.succeed([] as Array<AlertDestinationRow>)),
					)

				const enabled = rows.filter((row) => row.enabled === 1)

				const results = yield* Effect.forEach(
					enabled,
					(row: AlertDestinationRow) =>
						dispatchOne(row, context).pipe(
							Effect.map(() => "delivered" as const),
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
							Effect.catch(() => Effect.succeed("failed" as const)),
						),
					{ concurrency: "unbounded" },
				)

				return {
					delivered: results.filter((r) => r === "delivered").length,
					failed: results.filter((r) => r === "failed").length,
				}
			})

		return { dispatch } satisfies NotificationDispatcherShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
	static readonly Live = this.layer
	static readonly Default = this.layer
}
