import { Layer } from "effect"
import { appMemoMap, mapleApiClientLayer } from "@/lib/registry"
import { makeAppRuntime } from "@/lib/make-app-runtime"
import { mapleOtelLayer } from "./otel-layer"

export const runtime = makeAppRuntime(
	mapleApiClientLayer.pipe(Layer.provideMerge(mapleOtelLayer)),
	appMemoMap,
)
