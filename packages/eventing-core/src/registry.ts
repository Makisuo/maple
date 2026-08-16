import { makeCloudEvent } from "./event"
import { Schema } from "effect"
import type {
	JsonValue,
	MapleCloudEvent,
	NormalizedSignal,
	ProjectedEventData,
	SignalProjectionSpec,
} from "./model"
import { SignalProjectionSpecSchema } from "./model"
import { timestampToEpochNanos, compileSignalPredicate, validateSignalProjectionSpec } from "./predicate"
import { SignalSourceRegistry, validatePredicateAgainstSource } from "./source"

export interface SignalProjector<TConfig = unknown, TData extends JsonValue = JsonValue> {
	readonly id: string
	readonly version: number
	readonly sourceKinds: readonly string[]
	readonly outputType: string
	readonly dataSchema: string
	readonly decodeConfig: (value: unknown) => TConfig
	readonly decodeOutput: (value: unknown) => TData
	readonly project: (signal: NormalizedSignal, config: TConfig) => ProjectedEventData<TData>
}

type ErasedSignalProjector = SignalProjector<unknown, JsonValue>

export class ProjectorRegistry {
	readonly #projectors = new Map<string, ErasedSignalProjector>()

	register<TConfig, TData extends JsonValue>(projector: SignalProjector<TConfig, TData>): this {
		if (projector.id.trim().length === 0) throw new Error("projector ID must not be empty")
		if (!Number.isSafeInteger(projector.version) || projector.version < 1)
			throw new Error("projector version must be a positive safe integer")
		if (projector.sourceKinds.length === 0) throw new Error("projector must accept a source kind")
		if (projector.outputType.trim().length === 0)
			throw new Error("projector output type must not be empty")
		if (projector.dataSchema.trim().length === 0)
			throw new Error("projector data schema must not be empty")
		const key = ProjectorRegistry.key(projector.id, projector.version)
		if (this.#projectors.has(key)) throw new Error(`duplicate projector registration: ${key}`)
		this.#projectors.set(key, projector as unknown as ErasedSignalProjector)
		return this
	}

	get(id: string, version: number): ErasedSignalProjector | undefined {
		return this.#projectors.get(ProjectorRegistry.key(id, version))
	}

	static key(id: string, version: number): string {
		return `${id}@${version}`
	}
}

interface CompiledProjection {
	readonly spec: SignalProjectionSpec
	readonly evaluate: ReturnType<typeof compileSignalPredicate>
	readonly projector: ErasedSignalProjector
	readonly config: unknown
	readonly activeFromNanos: bigint
}

export interface ProjectionFailure {
	readonly projectionId: string
	readonly projectionRevision: number
	readonly occurrenceId: string | null
	readonly message: string
}

export interface ProjectionBatchResult {
	readonly events: readonly MapleCloudEvent[]
	readonly failures: readonly ProjectionFailure[]
	readonly typeMismatchFields: readonly string[]
}

const validateProjectedData = (value: ProjectedEventData): ProjectedEventData => {
	if (value.time !== undefined && timestampToEpochNanos(value.time) === null)
		throw new Error("projector returned an invalid event timestamp")
	return value
}

/** Immutable compiled snapshot. Hosts atomically replace the whole instance. */
export class CompiledProjectionRegistry {
	readonly #bySourceKind: ReadonlyMap<string, readonly CompiledProjection[]>

	private constructor(bySourceKind: ReadonlyMap<string, readonly CompiledProjection[]>) {
		this.#bySourceKind = bySourceKind
	}

	static compile(
		specs: readonly SignalProjectionSpec[],
		sources: SignalSourceRegistry,
		projectors: ProjectorRegistry,
	): CompiledProjectionRegistry {
		const bySourceKind = new Map<string, CompiledProjection[]>()
		const revisions = new Set<string>()

		for (const candidate of specs) {
			const spec = Schema.decodeUnknownSync(SignalProjectionSpecSchema)(candidate)
			const source = sources.get(spec.sourceKind)
			if (!source)
				throw new Error(
					`projection ${spec.id}@${spec.revision} references an unregistered source ${spec.sourceKind}`,
				)
			const issues = [
				...validateSignalProjectionSpec(spec),
				...validatePredicateAgainstSource(spec.selector, source),
			]
			if (issues.length > 0)
				throw new Error(
					`invalid projection ${spec.id}@${spec.revision}: ${issues
						.map(({ path, message }) => `${path}: ${message}`)
						.join("; ")}`,
				)
			const revisionKey = `${spec.tenantId}:${spec.id}@${spec.revision}`
			if (revisions.has(revisionKey)) throw new Error(`duplicate projection revision: ${revisionKey}`)
			revisions.add(revisionKey)
			if (!spec.enabled) continue

			const projector = projectors.get(spec.projector.id, spec.projector.version)
			if (!projector)
				throw new Error(
					`projection ${spec.id}@${spec.revision} references an unregistered projector ${spec.projector.id}@${spec.projector.version}`,
				)
			if (!projector.sourceKinds.includes(spec.sourceKind))
				throw new Error(
					`projector ${projector.id}@${projector.version} does not accept ${spec.sourceKind}`,
				)

			const compiled: CompiledProjection = {
				spec,
				evaluate: compileSignalPredicate(spec.selector),
				projector,
				config: projector.decodeConfig(spec.projector.config),
				activeFromNanos: timestampToEpochNanos(spec.activeFrom)!,
			}
			const bucket = bySourceKind.get(spec.sourceKind)
			if (bucket) bucket.push(compiled)
			else bySourceKind.set(spec.sourceKind, [compiled])
		}

		return new CompiledProjectionRegistry(bySourceKind)
	}

	evaluate(signal: NormalizedSignal): ProjectionBatchResult {
		const events: MapleCloudEvent[] = []
		const failures: ProjectionFailure[] = []
		const typeMismatchFields = new Set<string>()
		const observedAtNanos = timestampToEpochNanos(signal.observedAt)

		for (const projection of this.#bySourceKind.get(signal.sourceKind) ?? []) {
			if (projection.spec.tenantId !== signal.tenantId) continue
			if (observedAtNanos === null || observedAtNanos < projection.activeFromNanos) continue
			const evaluation = projection.evaluate(signal)
			for (const field of evaluation.typeMismatches)
				typeMismatchFields.add(`${field.namespace}:${field.key}`)
			if (!evaluation.matches) continue

			try {
				const projected = validateProjectedData(
					projection.projector.project(signal, projection.config),
				)
				events.push(
					makeCloudEvent({
						signal,
						projection: projection.spec,
						projectorId: projection.projector.id,
						projectorVersion: projection.projector.version,
						outputType: projection.projector.outputType,
						dataSchema: projection.projector.dataSchema,
						subject: projected.subject,
						time: projected.time,
						data: projection.projector.decodeOutput(projected.data),
					}),
				)
			} catch (error) {
				failures.push({
					projectionId: projection.spec.id,
					projectionRevision: projection.spec.revision,
					occurrenceId: signal.occurrenceId,
					message: error instanceof Error ? error.message : String(error),
				})
			}
		}

		return { events, failures, typeMismatchFields: [...typeMismatchFields] }
	}
}
