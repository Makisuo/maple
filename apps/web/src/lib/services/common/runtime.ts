import { Layer, ManagedRuntime } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { mapleApiClientLayer } from "@/lib/registry"
import { mapleOtelLayer } from "./otel-layer"

export { mapleOtelLayer }

export const runtime = ManagedRuntime.make(
	mapleApiClientLayer.pipe(Layer.provideMerge(mapleOtelLayer)),
	{ memoMap: Atom.defaultMemoMap },
)
