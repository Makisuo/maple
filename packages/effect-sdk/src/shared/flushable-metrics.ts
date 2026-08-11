import { Context, Layer, Metric } from "effect"

export interface MetricBuffer {
	readonly layer: Layer.Layer<never>
	readonly drain: () => Array<Metric.Metric.Snapshot>
	readonly restore: (items: ReadonlyArray<Metric.Metric.Snapshot>) => void
	readonly setDisabled: (value: boolean) => void
}

/**
 * Isolated Effect metric registry shared by a telemetry runtime and its
 * flush hook. Metric values are cumulative, so a flush snapshots rather than
 * clearing the registry. A snapshot is pending only after a metric changes;
 * failed exports mark it pending again through `restore`.
 */
export const makeMetricBuffer = (): MetricBuffer => {
	let disabled = false
	/** Whether anything has actually been recorded under a live grant. */
	let captured = false
	/** Whether the cumulative registry changed since the last drain. */
	let dirty = false
	/**
	 * Set when consent is withdrawn *after* something was recorded, and never
	 * cleared.
	 *
	 * Metric state is cumulative and cannot be un-accumulated: a counter that
	 * reached 5 under a grant still reads 5 after a revoke, so the first snapshot
	 * taken after a re-grant would export data the user asked us to forget —
	 * which the consent contract (`consent.ts`) forbids. Clearing the registry
	 * instead is not an option: `Metric` instances cache their metadata, so a
	 * cleared metric would keep updating an object no snapshot ever reads again —
	 * it would vanish permanently rather than restart at zero.
	 *
	 * So a revoke ends metrics for the life of the page. This is the same trade
	 * the OTLP preset makes by suppressing `/v1/metrics` outright under
	 * `requireConsent` (`consent-http-client.ts`); spans and logs, whose buffers
	 * *can* be dropped, resume normally after a re-grant. Gating on `captured`
	 * keeps the ordinary late-grant case (buffer starts disabled, nothing
	 * recorded yet, consent arrives) working normally.
	 */
	let revoked = false
	const registry = new Map<string, Metric.Metric.Metadata<any, any>>()
	// Metric instances cache their hooks, so gating only `drain()` would let
	// pre-consent updates surface in the first post-grant cumulative snapshot.
	// Wrap each hook as it is registered; denied updates never reach its state.
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
