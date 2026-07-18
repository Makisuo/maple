import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import {
	AlertComparator,
	AlertEventType,
	AlertIncidentStatus,
	AlertSeverity,
	AlertSignalType,
} from "../alerts"
import { AuthorizationV2, V2SchemaErrors } from "./auth"
import { ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2InvalidRequestError, V2NotFoundError, V2ServiceUnavailableError } from "./errors"
import { AlertIncidentPublicId, AlertRulePublicId, ErrorIssuePublicId } from "./resource-ids"

/** See api-keys.ts: examples are authored in wire (encoded) shape. */
const wireExample = <A>(example: object): A => example as A

const alertIncidentExample = {
	id: "inc_tC4d9V79DCDzgbGKhAnff9",
	object: "alert_incident",
	rule_id: "alrt_gU26thvJECdQvu54Ad9jiz",
	rule_name: "Checkout error rate",
	group_key: null,
	signal_type: "error_rate",
	severity: "critical",
	status: "open",
	comparator: "gt",
	threshold: 0.05,
	threshold_upper: null,
	first_triggered_at: "2026-07-15T09:10:00.000Z",
	last_triggered_at: "2026-07-15T09:40:00.000Z",
	resolved_at: null,
	last_observed_value: 0.09,
	last_sample_count: 132,
	dedupe_key: "alrt_gU26thvJECdQvu54Ad9jiz:__total__",
	last_delivered_event_type: "trigger",
	last_notified_at: "2026-07-15T09:10:05.000Z",
	error_issue_id: null,
} as const

// v2 wire schemas are annotated `Schema.Struct`s (not `Schema.Class`) — see the
// note in api-keys.ts.
export const V2AlertIncident = Schema.Struct({
	id: AlertIncidentPublicId,
	object: Schema.Literal("alert_incident").annotate({
		description: 'The object type — always `"alert_incident"`.',
		examples: ["alert_incident"],
	}),
	rule_id: AlertRulePublicId.annotate({
		description: "The alert rule (`alrt_…`) that opened this incident.",
	}),
	rule_name: Schema.String.annotate({
		description: "Name of the rule at the time the incident was recorded.",
		examples: ["Checkout error rate"],
	}),
	group_key: Schema.NullOr(Schema.String).annotate({
		description: "The breaching group for grouped rules, or `null` for ungrouped rules.",
	}),
	signal_type: AlertSignalType.annotate({
		description: "The signal the rule measures.",
		examples: ["error_rate"],
	}),
	severity: AlertSeverity.annotate({
		description: "Severity inherited from the rule: `warning` or `critical`.",
		examples: ["critical"],
	}),
	status: AlertIncidentStatus.annotate({
		description:
			"`open` while the breach persists; `resolved` once enough consecutive healthy checks are observed. Incident resolution is scheduler-driven — incidents cannot be closed via the API.",
		examples: ["open"],
	}),
	comparator: AlertComparator,
	threshold: Schema.Number.annotate({
		description: "The rule threshold at the time the incident opened.",
		examples: [0.05],
	}),
	threshold_upper: Schema.NullOr(Schema.Number),
	first_triggered_at: Timestamp.annotate({ description: "When the incident opened." }),
	last_triggered_at: Timestamp.annotate({ description: "When the breach was most recently observed." }),
	resolved_at: Schema.NullOr(Timestamp).annotate({
		description: "When the incident resolved, or `null` while it is still open.",
	}),
	last_observed_value: Schema.NullOr(Schema.Number).annotate({
		description: "The most recently observed value, or `null`.",
		examples: [0.09],
	}),
	last_sample_count: Schema.NullOr(Schema.Number).annotate({
		description: "Sample count of the most recent observation, or `null`.",
	}),
	dedupe_key: Schema.String.annotate({
		description:
			"Stable identity of the (rule, group) incident stream, used to deduplicate notifications.",
	}),
	last_delivered_event_type: Schema.NullOr(AlertEventType).annotate({
		description:
			"The most recent notification event delivered for this incident (`trigger`, `resolve`, `renotify`, `test`), or `null`.",
	}),
	last_notified_at: Schema.NullOr(Timestamp).annotate({
		description: "When a notification was last delivered for this incident, or `null`.",
	}),
	error_issue_id: Schema.NullOr(ErrorIssuePublicId).annotate({
		description: "The linked error issue (`iss_…`) when the incident was correlated to one, or `null`.",
	}),
}).annotate({
	identifier: "AlertIncident",
	title: "Alert Incident",
	description:
		"A period during which an alert rule's condition held: opened after enough consecutive breaches, resolved by the scheduler after enough consecutive healthy checks. Read-only via the API.",
	examples: [wireExample(alertIncidentExample)],
})
export type V2AlertIncident = Schema.Schema.Type<typeof V2AlertIncident>

const IncidentsQuery = Schema.Struct({
	...ListQuery.fields,
	status: Schema.optional(
		AlertIncidentStatus.annotate({
			description: "Only return incidents with this status (`open` or `resolved`).",
			examples: ["open"],
		}),
	),
	rule_id: Schema.optional(
		AlertRulePublicId.annotate({
			description: "Only return incidents opened by this alert rule (`alrt_…`).",
		}),
	),
}).annotate({
	identifier: "AlertIncidentListQuery",
	title: "Alert incident list query",
	description: "Pagination plus optional status / rule filters.",
})

const commonErrors = [V2InvalidRequestError, V2ServiceUnavailableError] as const

const AlertIncidentList = ListOf(V2AlertIncident).annotate({
	identifier: "AlertIncidentList",
	title: "Alert incident list",
	description: "A cursor-paginated page of alert incidents.",
})

export class V2AlertIncidentsApiGroup extends HttpApiGroup.make("alertIncidents")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: IncidentsQuery,
			success: AlertIncidentList,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listAlertIncidents",
				summary: "List alert incidents",
				description:
					"Returns your organization's alert incidents, most recently triggered first, optionally filtered by `status` or `rule_id`. Cursor-paginated. Requires the `alerts:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: AlertIncidentPublicId },
			success: V2AlertIncident,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getAlertIncident",
				summary: "Retrieve an alert incident",
				description:
					"Returns a single alert incident by its `inc_…` ID. Requires the `alerts:read` scope.",
			}),
		),
	)
	.prefix("/v2/alerts/incidents")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Alert Incidents",
			description:
				"The incident history produced by your alert rules. Incidents open when a rule breaches for enough consecutive checks and resolve automatically once the signal recovers — this surface is read-only.",
		}),
	) {}
