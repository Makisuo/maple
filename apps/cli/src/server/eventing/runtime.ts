import {
	CompiledProjectionRegistry,
	ProjectorRegistry,
	SignalSourceRegistry,
	assertSignalProjectionInputBudget,
	fieldKey,
	isJsonValue,
	SignalProjectionSpecSchema,
	type MapleCloudEvent,
	type NormalizedSignal,
	type ProjectionFailure,
	type SignalProjectionSpec,
	type SignalScalar,
} from "@maple/eventing-core"
import { Schema } from "effect"
import { LocalEventingControlStore } from "./control-store"
import { OTLP_LOG_ADAPTER } from "./otlp"

const TENANT_ID = "local"

interface GitLabIssueProjectorConfig {
	readonly includeBody: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const gitlabProjectorConfig = (value: unknown): GitLabIssueProjectorConfig => {
	if (!isRecord(value)) throw new Error("gitlab.issue.created projector config must be an object")
	const keys = Object.keys(value)
	if (keys.some((key) => key !== "includeBody"))
		throw new Error("gitlab.issue.created projector config contains an unknown field")
	if (value.includeBody !== undefined && typeof value.includeBody !== "boolean")
		throw new Error("gitlab.issue.created includeBody must be boolean")
	return { includeBody: value.includeBody === true }
}

const field = (signal: NormalizedSignal, namespace: "resource" | "attribute", key: string) =>
	signal.fields.get(fieldKey({ namespace, key }))

const scalarString = (value: SignalScalar | undefined, label: string, required = false) => {
	if (value === undefined) {
		if (required) throw new Error(`GitLab issue event is missing ${label}`)
		return undefined
	}
	if (value.type !== "string") throw new Error(`GitLab issue event ${label} must be a string`)
	return value.value
}

const scalarInt64 = (value: SignalScalar | undefined, label: string, required = false) => {
	if (value === undefined) {
		if (required) throw new Error(`GitLab issue event is missing ${label}`)
		return undefined
	}
	if (value.type !== "int64") throw new Error(`GitLab issue event ${label} must be an int64`)
	return value.value
}

const gitlabIssueProjector = {
	id: "gitlab.issue.created",
	version: 1,
	sourceKinds: ["otel.log"],
	outputType: "dev.maple.gitlab.issue.created.v1",
	dataSchema: "urn:maple:event-schema:gitlab-issue-created:v1",
	decodeConfig: gitlabProjectorConfig,
	project: (signal: NormalizedSignal, config: GitLabIssueProjectorConfig) => {
		const projectId = scalarInt64(field(signal, "attribute", "gitlab.project.id"), "gitlab.project.id")
		const projectPath = scalarString(
			field(signal, "attribute", "gitlab.project.path"),
			"gitlab.project.path",
			true,
		)!
		const issueId = scalarInt64(field(signal, "attribute", "gitlab.issue.id"), "gitlab.issue.id")
		const issueIid = scalarInt64(
			field(signal, "attribute", "gitlab.issue.iid"),
			"gitlab.issue.iid",
			true,
		)!
		const title = scalarString(field(signal, "attribute", "gitlab.issue.title"), "gitlab.issue.title")
		const url = scalarString(field(signal, "attribute", "gitlab.issue.url"), "gitlab.issue.url")
		const actorId = scalarInt64(field(signal, "attribute", "gitlab.user.id"), "gitlab.user.id")
		const actorUsername = scalarString(
			field(signal, "attribute", "gitlab.user.username"),
			"gitlab.user.username",
		)
		const serviceName = scalarString(field(signal, "resource", "service.name"), "service.name")
		const candidateBody =
			isRecord(signal.data) && isRecord(signal.data.record) ? signal.data.record.body : undefined
		const body = isJsonValue(candidateBody) ? candidateBody : undefined
		return {
			subject: `${projectPath}/issues/${issueIid}`,
			data: {
				project: {
					...(projectId === undefined ? {} : { id: projectId }),
					path: projectPath,
				},
				issue: {
					...(issueId === undefined ? {} : { id: issueId }),
					iid: issueIid,
					...(title === undefined ? {} : { title }),
					...(url === undefined ? {} : { url }),
				},
				...(actorId === undefined && actorUsername === undefined
					? {}
					: {
							actor: {
								...(actorId === undefined ? {} : { id: actorId }),
								...(actorUsername === undefined ? {} : { username: actorUsername }),
							},
						}),
				...(serviceName === undefined ? {} : { serviceName }),
				...(config.includeBody && body !== undefined ? { body } : {}),
			},
		}
	},
} as const

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
		this.#projectors = new ProjectorRegistry().register(gitlabIssueProjector)
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

	health() {
		return {
			activeProjections: this.listActive().length,
			outboxCapacity: this.#store.outboxCapacity(),
			...this.#store.validate(),
		}
	}
}
