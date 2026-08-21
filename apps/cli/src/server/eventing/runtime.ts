import { createHash } from "node:crypto"
import {
	canonicalJson,
	CompiledProjectionRegistry,
	isJsonValue,
	ProjectorRegistry,
	SignalSourceRegistry,
	assertSignalProjectionInputBudget,
	SignalProjectionSpecSchema,
	type MapleCloudEvent,
	type JsonValue,
	type NormalizedSignal,
	type ProjectionFailure,
	type SignalProjectionSpec,
} from "@maple/eventing-core"
import { Schema } from "effect"
import { LocalEventingControlStore } from "./control-store"
import type { EventConsumerStart } from "./control-store"
import { normalizeOtlpLogsWithDiagnostics, OTLP_LOG_ADAPTER } from "./otlp"
import { NOOP_EVENTING_TELEMETRY, type EventingTelemetry } from "./telemetry"

const TENANT_ID = "local"

export interface LocalProjectionEvaluation {
	readonly events: readonly MapleCloudEvent[]
	readonly eventSourceFingerprints: ReadonlyMap<string, string>
	readonly recoveredEventIds: readonly string[]
	readonly failures: readonly ProjectionFailure[]
	readonly typeMismatchFields: readonly string[]
}

export interface LocalProjectionActivation {
	readonly spec: SignalProjectionSpec
	readonly next: readonly SignalProjectionSpec[]
	readonly compiled: CompiledProjectionRegistry
	readonly generation: number
}

const emptyEvaluation = (): LocalProjectionEvaluation => ({
	events: [],
	eventSourceFingerprints: new Map(),
	recoveredEventIds: [],
	failures: [],
	typeMismatchFields: [],
})

export const sourceOccurrenceFingerprint = (signal: NormalizedSignal): string => {
	if (!isJsonValue(signal.data)) throw new Error("normalized source occurrence must contain finite JSON")
	const content: JsonValue = {
		sourceKind: signal.sourceKind,
		source: signal.source,
		tenantId: signal.tenantId,
		occurrenceId: signal.occurrenceId,
		identityQuality: signal.identityQuality,
		occurredAt: signal.occurredAt,
		observedAt: signal.observedAt,
		subject: signal.subject,
		fields: [...signal.fields.entries()]
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, value]) => ({ key, value })),
		data: signal.data,
	}
	return `sha256:${createHash("sha256").update(canonicalJson(content)).digest("hex")}`
}

export class LocalEventingRuntime {
	readonly #store: LocalEventingControlStore
	readonly #sources: SignalSourceRegistry
	readonly #projectors: ProjectorRegistry
	readonly #telemetry: EventingTelemetry
	#compiled: CompiledProjectionRegistry
	#activeSourceKinds = new Set<string>()
	#generation = 0

	constructor(
		store: LocalEventingControlStore,
		telemetry: EventingTelemetry = NOOP_EVENTING_TELEMETRY,
		projectors: ProjectorRegistry = new ProjectorRegistry(),
	) {
		this.#store = store
		this.#telemetry = telemetry
		this.#sources = new SignalSourceRegistry().register(OTLP_LOG_ADAPTER.definition)
		this.#projectors = projectors
		const specs = store.loadEnabledProjections(TENANT_ID)
		this.#compiled = CompiledProjectionRegistry.compile(specs, this.#sources, this.#projectors)
		this.#activeSourceKinds = new Set(specs.map(({ sourceKind }) => sourceKind))
	}

	hasActiveSource(sourceKind: string): boolean {
		return this.#activeSourceKinds.has(sourceKind)
	}

	prepareActivation(candidate: unknown): LocalProjectionActivation {
		assertSignalProjectionInputBudget(candidate)
		const spec = Schema.decodeUnknownSync(SignalProjectionSpecSchema)(candidate)
		if (spec.tenantId !== TENANT_ID)
			throw new Error(`Maple Local only accepts projections for tenant ${TENANT_ID}`)
		const active = this.#store
			.loadEnabledProjections(TENANT_ID)
			.filter((candidate) => candidate.id !== spec.id)
		const next = spec.enabled ? [...active, spec] : active
		const compiled = CompiledProjectionRegistry.compile(next, this.#sources, this.#projectors)
		return { spec, next, compiled, generation: this.#generation }
	}

	commitActivation(activation: LocalProjectionActivation): void {
		if (activation.generation !== this.#generation)
			throw new Error("projection registry changed during activation; retry the request")
		this.#store.saveProjection(activation.spec)
		this.#compiled = activation.compiled
		this.#activeSourceKinds = new Set(activation.next.map(({ sourceKind }) => sourceKind))
		this.#generation += 1
	}

	activate(candidate: unknown): void {
		this.commitActivation(this.prepareActivation(candidate))
	}

	listActive(): readonly SignalProjectionSpec[] {
		return this.#store.loadEnabledProjections(TENANT_ID)
	}

	evaluateOtlp(
		signal: "traces" | "logs" | "metrics",
		decoded: unknown,
		isRetiredUtcDay: (rangeDate: string) => boolean = () => false,
	): LocalProjectionEvaluation {
		const sourceKind = signal === "logs" ? "otel.log" : signal === "traces" ? "otel.span" : "otel.metric"
		if (!this.hasActiveSource(sourceKind) && !this.#store.hasStagedSourceKind(TENANT_ID, sourceKind))
			return emptyEvaluation()
		const startedAt = performance.now()
		const acceptedAt = new Date().toISOString()
		let normalized
		try {
			const result =
				signal === "logs"
					? normalizeOtlpLogsWithDiagnostics(decoded, acceptedAt, TENANT_ID)
					: { signals: [], unprojectedIdentities: [], ineligible: 0, failures: 0 }
			normalized = result.signals
			this.#telemetry.record({
				operation: "normalization",
				outcome: "success",
				count: normalized.length,
				durationMs: performance.now() - startedAt,
				sourceKind,
			})
			if (result.failures > 0)
				this.#telemetry.record({
					operation: "normalization",
					outcome: "failure",
					count: result.failures,
					sourceKind,
				})
			for (const identity of result.unprojectedIdentities)
				if (
					this.#store.hasStagedSourceOccurrence(
						identity.tenantId,
						identity.sourceKind,
						identity.source,
						identity.occurrenceId,
					)
				)
					throw new Error(
						`cannot safely recover staged source occurrence after projection normalization failed: ${identity.occurrenceId}`,
					)
		} catch (error) {
			this.#telemetry.record({
				operation: "normalization",
				outcome: "failure",
				durationMs: performance.now() - startedAt,
				sourceKind,
			})
			throw error
		}
		const snapshot = this.#compiled
		const events: MapleCloudEvent[] = []
		const eventSourceFingerprints = new Map<string, string>()
		const recoveredEventIds: string[] = []
		const failures: ProjectionFailure[] = []
		const typeMismatchFields = new Set<string>()
		for (const occurrence of normalized) {
			const sourceFingerprint = sourceOccurrenceFingerprint(occurrence)
			if (occurrence.occurrenceId !== null) {
				const staged = this.#store.stagedEventIdsForOccurrence(
					occurrence.tenantId,
					occurrence.sourceKind,
					occurrence.source,
					occurrence.occurrenceId,
					sourceFingerprint,
				)
				if (staged.length > 0) {
					recoveredEventIds.push(...staged)
					continue
				}
			}
			if (isRetiredUtcDay(occurrence.occurredAt.slice(0, 10))) continue
			const result = snapshot.evaluate(occurrence, acceptedAt)
			this.#telemetry.record({
				operation: "projection",
				outcome: "success",
				count: result.events.length,
				sourceKind,
			})
			this.#telemetry.record({
				operation: "projection",
				outcome: "failure",
				count: result.failures.length,
				sourceKind,
			})
			events.push(...result.events)
			for (const event of result.events) {
				const priorFingerprint = eventSourceFingerprints.get(event.id)
				if (priorFingerprint !== undefined && priorFingerprint !== sourceFingerprint)
					throw new Error(`source occurrence collision within one ingest batch: ${event.id}`)
				eventSourceFingerprints.set(event.id, sourceFingerprint)
			}
			failures.push(...result.failures)
			for (const mismatch of result.typeMismatchFields) typeMismatchFields.add(mismatch)
		}
		if (typeMismatchFields.size > 0)
			this.#telemetry.record({
				operation: "selector_type_mismatch",
				outcome: "observed",
				count: typeMismatchFields.size,
				sourceKind,
			})
		return {
			events,
			eventSourceFingerprints,
			recoveredEventIds,
			failures,
			typeMismatchFields: [...typeMismatchFields],
		}
	}

	persistFailures(failures: readonly ProjectionFailure[]): void {
		if (failures.length > 0) this.#store.recordProjectionFailures(TENANT_ID, failures)
	}

	stage(events: readonly MapleCloudEvent[], sourceFingerprints: ReadonlyMap<string, string> = new Map()) {
		return this.#store.stageEvents(events, sourceFingerprints)
	}

	markReady(eventIds: readonly string[]): void {
		this.#store.markReady(eventIds)
	}

	listReady(limit?: number, after?: number) {
		return this.#store.listReady(limit, after)
	}

	listStaged(limit?: number, after?: number) {
		return this.#store.listStaged(limit, after)
	}

	listConsumers() {
		return this.#store.listConsumers(TENANT_ID)
	}

	registerConsumer(consumerId: string, startAt: EventConsumerStart) {
		return this.#store.registerConsumer(TENANT_ID, consumerId, startAt)
	}

	disableConsumer(consumerId: string) {
		return this.#store.disableConsumer(TENANT_ID, consumerId)
	}

	claimReady(consumerId: string, limit: number, leaseSeconds: number) {
		return this.#store.claimReady(TENANT_ID, consumerId, limit, leaseSeconds)
	}

	acknowledgeClaim(consumerId: string, leaseToken: string, throughSequence: number) {
		return this.#store.acknowledgeClaim(TENANT_ID, consumerId, leaseToken, throughSequence)
	}

	health() {
		return {
			activeProjections: this.listActive().length,
			outboxCapacity: this.#store.outboxCapacity(),
			...this.#store.validate(),
		}
	}
}
