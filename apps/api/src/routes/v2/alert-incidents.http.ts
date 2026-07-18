import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { AlertIncidentDocument } from "@maple/domain/http"
import { CurrentTenant } from "@maple/domain/http"
import type { V2AlertIncident } from "@maple/domain/http/v2"
import {
	LIST_LIMIT_DEFAULT,
	MapleApiV2,
	decodeOffsetCursorEffect,
	encodeOffsetCursor,
} from "@maple/domain/http/v2"
import { Effect } from "effect"
import { AlertsService } from "../../services/AlertsService"
import { mapAlertError } from "./alerts-error-map"

const toV2Incident = (doc: AlertIncidentDocument): V2AlertIncident => ({
	id: doc.id,
	object: "alert_incident",
	rule_id: doc.ruleId,
	rule_name: doc.ruleName,
	group_key: doc.groupKey,
	signal_type: doc.signalType,
	severity: doc.severity,
	status: doc.status,
	comparator: doc.comparator,
	threshold: doc.threshold,
	threshold_upper: doc.thresholdUpper,
	first_triggered_at: doc.firstTriggeredAt,
	last_triggered_at: doc.lastTriggeredAt,
	resolved_at: doc.resolvedAt,
	last_observed_value: doc.lastObservedValue,
	last_sample_count: doc.lastSampleCount,
	dedupe_key: doc.dedupeKey,
	last_delivered_event_type: doc.lastDeliveredEventType,
	last_notified_at: doc.lastNotifiedAt,
	error_issue_id: doc.errorIssueId,
})

export const HttpV2AlertIncidentsLive = HttpApiBuilder.group(MapleApiV2, "alertIncidents", (handlers) =>
	Effect.gen(function* () {
		const alerts = yield* AlertsService

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const limit = query.limit ?? LIST_LIMIT_DEFAULT
					const offset = yield* decodeOffsetCursorEffect(query.cursor)
					const response = yield* alerts
						.listIncidents(tenant.orgId, {
							...(query.status !== undefined ? { status: query.status } : {}),
							...(query.rule_id !== undefined ? { ruleId: query.rule_id } : {}),
							limit: limit + 1,
							offset,
						})
						.pipe(Effect.mapError(mapAlertError))
					const items = response.incidents.map(toV2Incident)
					const hasMore = items.length > limit
					return {
						object: "list" as const,
						data: hasMore ? items.slice(0, limit) : items,
						has_more: hasMore,
						next_cursor: hasMore ? encodeOffsetCursor(offset + limit) : null,
					}
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const incident = yield* alerts
						.getIncident(tenant.orgId, params.id)
						.pipe(Effect.mapError(mapAlertError))
					return toV2Incident(incident)
				}),
			)
	}),
)
