import { Context, Layer, Metric } from "effect"

export interface MetricBuffer {
	readonly layer: Layer.Layer<never>
	readonly drain: () => Array<Metric.Metric.Snapshot>
	readonly restore: (items: ReadonlyArray<Metric.Metric.Snapshot>) => void
}

/**
 * Isolated Effect metric registry shared by a telemetry runtime and its
 * flush hook. Metric values are cumulative, so a flush snapshots rather than
 * clearing the registry; `restore` is intentionally a no-op.
 */
export const makeMetricBuffer = (): MetricBuffer => {
	const registry = new Map<string, Metric.Metric.Metadata<any, any>>()
	const snapshotContext = Context.make(Metric.MetricRegistry, registry)
	return {
		layer: Layer.succeed(Metric.MetricRegistry, registry),
		drain: () => [...Metric.snapshotUnsafe(snapshotContext)],
		restore: () => undefined,
	}
}
