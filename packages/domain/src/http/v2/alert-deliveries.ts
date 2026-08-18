import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { AlertDeliveryStatus, AlertDestinationType, AlertEventType, AlertPersistenceError } from "../alerts"
import { AuthorizationV2 } from "./auth"
import { ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2ParameterInvalid } from "./errors"
import { publicError } from "./public-error"
import {
	AlertDeliveryEventPublicId,
	AlertDestinationPublicId,
	AlertIncidentPublicId,
	AlertRulePublicId,
} from "./resource-ids"

/** A single attempt to deliver an alert notification to a destination. */
export const V2AlertDelivery = Schema.Struct({
	id: AlertDeliveryEventPublicId,
	object: Schema.Literal("alert_delivery"),
	incident_id: Schema.NullOr(AlertIncidentPublicId),
	rule_id: AlertRulePublicId,
	destination_id: AlertDestinationPublicId,
	destination_name: Schema.String,
	destination_type: AlertDestinationType,
	delivery_key: Schema.String,
	event_type: AlertEventType,
	attempt_number: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
	status: AlertDeliveryStatus,
	scheduled_at: Timestamp,
	attempted_at: Schema.NullOr(Timestamp),
	provider_message: Schema.NullOr(Schema.String),
	provider_reference: Schema.NullOr(Schema.String),
	response_code: Schema.NullOr(Schema.Number),
	error_message: Schema.NullOr(Schema.String),
}).annotate({
	identifier: "AlertDelivery",
	title: "Alert Delivery",
	description:
		"One notification delivery attempt produced by an alert rule. This is the canonical delivery-history resource used by both the dashboard and API clients.",
})
export type V2AlertDelivery = Schema.Schema.Type<typeof V2AlertDelivery>

const DeliveriesQuery = Schema.Struct({
	...ListQuery.fields,
	incident_id: Schema.optional(
		AlertIncidentPublicId.annotate({
			description: "Only return deliveries produced for this incident (`inc_…`).",
		}),
	),
	rule_id: Schema.optional(
		AlertRulePublicId.annotate({
			description: "Only return deliveries produced by this alert rule (`alrt_…`).",
		}),
	),
}).annotate({
	identifier: "AlertDeliveryListQuery",
	title: "Alert delivery list query",
	description: "Pagination plus optional incident / rule filters.",
})

const AlertDeliveryList = ListOf(V2AlertDelivery).annotate({
	identifier: "AlertDeliveryList",
	title: "Alert delivery list",
})

export class V2AlertDeliveriesApiGroup extends HttpApiGroup.make("alertDeliveries")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: DeliveriesQuery,
			success: AlertDeliveryList,
			error: [V2ParameterInvalid.schema, publicError(AlertPersistenceError)],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listAlertDeliveries",
				summary: "List alert deliveries",
				description:
					"Returns the organization's most recent alert notification attempts, newest first, optionally filtered by `incident_id` or `rule_id`. Requires the `alerts:read` scope.",
			}),
		),
	)
	.prefix("/v2/alerts/deliveries")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Alert Deliveries",
			description: "Read-only notification delivery history for alert rules.",
		}),
	) {}
