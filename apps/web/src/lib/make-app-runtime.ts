import { Layer, ManagedRuntime } from "effect"

/**
 * Builds an imperative app runtime on the same memoization boundary as the
 * atom registry. Any layer shared with atoms is acquired once and reused by
 * both execution paths.
 */
export const makeAppRuntime = <R, E>(
	layer: Layer.Layer<R, E, never>,
	memoMap: Layer.MemoMap,
): ManagedRuntime.ManagedRuntime<R, E> => ManagedRuntime.make(layer, { memoMap })
