import { Context, Layer, Metric } from "effect"

export interface MetricBuffer {
	readonly layer: Layer.Layer<never>
	readonly drain: () => Array<Metric.Metric.Snapshot>
	readonly restore: (items: ReadonlyArray<Metric.Metric.Snapshot>) => void
	readonly setDisabled: (value: boolean) => void
}

/**
 * Isolated cumulative registry. Drains only after changes, and `restore`
 * re-marks failed exports as pending.
 */
export const makeMetricBuffer = (): MetricBuffer => {
	let disabled = false
	let captured = false
	let dirty = false
	/**
	 * Revoking after capture disables metrics for the page lifetime. Cumulative
	 * state cannot forget prior samples, and clearing the registry breaks cached
	 * Metric hooks. A late first grant still works because `captured` is false.
	 */
	let revoked = false
	const registry = new Map<string, Metric.Metric.Metadata<any, any>>()
	// Gate hooks so pre-consent updates never enter cumulative state.
	const set = registry.set.bind(registry)
	registry.set = (key, metadata) => {
		const hooks = metadata.hooks
		;(metadata as { hooks: Metric.Metric.Hooks<any, any> }).hooks = {
			get: hooks.get,
			update: (input, context) => {
				if (disabled) return
				captured = true
				hooks.update(input, context)
				dirty = true
			},
			modify: (input, context) => {
				if (disabled) return
				captured = true
				hooks.modify(input, context)
				dirty = true
			},
		}
		return set(key, metadata)
	}
	const snapshotContext = Context.make(Metric.MetricRegistry, registry)
	return {
		layer: Layer.succeed(Metric.MetricRegistry, registry),
		drain: () => {
			if (disabled || revoked || !dirty) return []
			dirty = false
			return [...Metric.snapshotUnsafe(snapshotContext)]
		},
		restore: (items) => {
			if (items.length > 0) dirty = true
		},
		setDisabled: (value) => {
			if (value && captured) revoked = true
			disabled = value
		},
	}
}
