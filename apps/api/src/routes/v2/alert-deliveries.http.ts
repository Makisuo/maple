import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { AlertDeliveryEventDocument } from "@maple/domain/http"
import { CurrentTenant } from "@maple/domain/http"
import type { V2AlertDelivery } from "@maple/domain/http/v2"
import { MapleApiV2, paginateOffsetQuery, timestamp, timestampOrNull } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { AlertsService } from "@/services/AlertsService"
import { mapAlertError } from "./alerts-error-map"

const toV2Delivery = (doc: AlertDeliveryEventDocument): V2AlertDelivery => ({
	id: doc.id,
	object: "alert_delivery",
	incident_id: doc.incidentId,
	rule_id: doc.ruleId,
	destination_id: doc.destinationId,
	destination_name: doc.destinationName,
	destination_type: doc.destinationType,
	delivery_key: doc.deliveryKey,
	event_type: doc.eventType,
	attempt_number: doc.attemptNumber,
	status: doc.status,
	scheduled_at: timestamp(doc.scheduledAt),
	attempted_at: timestampOrNull(doc.attemptedAt),
	provider_message: doc.providerMessage,
	provider_reference: doc.providerReference,
	response_code: doc.responseCode,
	error_message: doc.errorMessage,
})

export const HttpV2AlertDeliveriesLive = HttpApiBuilder.group(MapleApiV2, "alertDeliveries", (handlers) =>
	Effect.gen(function* () {
		const alerts = yield* AlertsService
		return handlers.handle("list", ({ query }) =>
			Effect.gen(function* () {
				const tenant = yield* CurrentTenant.Context
				const page = yield* paginateOffsetQuery(query, ({ limit, offset }) =>
					alerts.listDeliveryEvents(tenant.orgId, { limit, offset }).pipe(
						mapAlertError("delivery_list"),
						Effect.map((response) => response.events.map(toV2Delivery)),
					),
				)
				return { object: "list" as const, ...page }
			}),
		)
	}),
)
