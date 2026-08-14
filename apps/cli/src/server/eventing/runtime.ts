import {
	CompiledProjectionRegistry,
	ProjectorRegistry,
	SignalSourceRegistry,
	assertSignalProjectionInputBudget,
	SignalProjectionSpecSchema,
	type MapleCloudEvent,
	type ProjectionFailure,
	type SignalProjectionSpec,
} from "@maple/eventing-core"
import { Schema } from "effect"
import { LocalEventingControlStore } from "./control-store"
import type { EventConsumerStart } from "./control-store"
import { registerGitLabProjectors } from "./gitlab-projectors"
import { OTLP_LOG_ADAPTER } from "./otlp"

const TENANT_ID = "local"

export interface LocalProjectionEvaluation {
	readonly events: readonly MapleCloudEvent[]
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
	failures: [],
	typeMismatchFields: [],
})

export class LocalEventingRuntime {
	readonly #store: LocalEventingControlStore
	readonly #sources: SignalSourceRegistry
	readonly #projectors: ProjectorRegistry
	#compiled: CompiledProjectionRegistry
	#activeSourceKinds = new Set<string>()
	#generation = 0

	constructor(store: LocalEventingControlStore) {
		this.#store = store
		this.#sources = new SignalSourceRegistry().register(OTLP_LOG_ADAPTER.definition)
		this.#projectors = registerGitLabProjectors(new ProjectorRegistry())
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
		if (!this.hasActiveSource(sourceKind)) return emptyEvaluation()
		const acceptedAt = new Date().toISOString()
		const normalized = (
			signal === "logs" ? OTLP_LOG_ADAPTER.normalize(decoded, { acceptedAt, tenantId: TENANT_ID }) : []
		).filter((occurrence) => !isRetiredUtcDay(occurrence.occurredAt.slice(0, 10)))
		const snapshot = this.#compiled
		const events: MapleCloudEvent[] = []
		const failures: ProjectionFailure[] = []
		const typeMismatchFields = new Set<string>()
		for (const occurrence of normalized) {
			const result = snapshot.evaluate(occurrence)
			events.push(...result.events)
			failures.push(...result.failures)
			for (const mismatch of result.typeMismatchFields) typeMismatchFields.add(mismatch)
		}
		return { events, failures, typeMismatchFields: [...typeMismatchFields] }
	}

	persistFailures(failures: readonly ProjectionFailure[]): void {
		if (failures.length > 0) this.#store.recordProjectionFailures(TENANT_ID, failures)
	}

	stage(events: readonly MapleCloudEvent[]) {
		return this.#store.stageEvents(events)
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
