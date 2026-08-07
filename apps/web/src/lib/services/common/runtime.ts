import { Layer, ManagedRuntime } from "effect"
import { appMemoMap, mapleApiClientLayer } from "@/lib/registry"
import { mapleOtelLayer } from "./otel-layer"

export const runtime = ManagedRuntime.make(mapleApiClientLayer.pipe(Layer.provideMerge(mapleOtelLayer)), {
	memoMap: appMemoMap,
})
