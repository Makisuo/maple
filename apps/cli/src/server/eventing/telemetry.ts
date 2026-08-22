import { Effect, Metric } from "effect"

export type EventingTelemetryOperation =
	| "normalization"
	| "projection"
	| "selector_type_mismatch"
	| "outbox_stage"
	| "outbox_ready"
	| "outbox_dedup"
	| "consumer_claim"
	| "consumer_ack"
	| "consumer_lease"
	| "consumer_lag"

export type EventingTelemetryOutcome =
	| "success"
	| "failure"
	| "empty"
	| "active"
	| "expired"
	| "reclaimed"
	| "observed"

export type EventingTelemetrySourceKind = "otel.log" | "otel.span" | "otel.metric" | "unknown"

/** Deliberately excludes tenant, consumer, event, projection, payload, and credential values. */
export interface EventingTelemetryObservation {
	readonly operation: EventingTelemetryOperation
	readonly outcome: EventingTelemetryOutcome
	readonly count?: number
	readonly durationMs?: number
	readonly lag?: number
	readonly sourceKind?: EventingTelemetrySourceKind
}

export interface EventingTelemetry {
	record(observation: EventingTelemetryObservation): void
}

export const NOOP_EVENTING_TELEMETRY: EventingTelemetry = { record: () => {} }

const operations = Metric.counter("maple.eventing.operations_total", {
	description: "Eventing operations by bounded operation and outcome",
	incremental: true,
})
const durations = Metric.histogram("maple.eventing.operation_duration_ms", {
	description: "Eventing operation duration in milliseconds",
	boundaries: [0.1, 0.5, 1, 5, 10, 50, 100, 500, 1_000, 5_000],
})
const consumerLag = Metric.histogram("maple.eventing.consumer_lag_events", {
	description: "Ready-event sequence lag observed by event consumers",
	boundaries: [0, 1, 5, 10, 50, 100, 500, 1_000, 10_000],
})

export const makeEffectEventingTelemetry = (
	run: (effect: Effect.Effect<void>) => void,
): EventingTelemetry => ({
	record(observation) {
		const attributes = {
			operation: observation.operation,
			outcome: observation.outcome,
			source_kind: observation.sourceKind ?? "unknown",
		}
		const effects: Effect.Effect<void>[] = []
		const count = observation.count ?? 1
		if (Number.isFinite(count) && count > 0)
			effects.push(Metric.update(Metric.withAttributes(operations, attributes), count))
		if (observation.durationMs !== undefined && Number.isFinite(observation.durationMs))
			effects.push(
				Metric.update(
					Metric.withAttributes(durations, attributes),
					Math.max(0, observation.durationMs),
				),
			)
		if (observation.lag !== undefined && Number.isSafeInteger(observation.lag))
			effects.push(
				Metric.update(Metric.withAttributes(consumerLag, attributes), Math.max(0, observation.lag)),
			)
		if (effects.length > 0) run(Effect.all(effects, { discard: true }))
	},
})
