import { Layer, ManagedRuntime } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { Maple } from "@maple-dev/effect-sdk/client"
import { mapleApiClientLayer } from "@/lib/registry"
import { ingestUrl } from "./ingest-url"

export const mapleOtelLayer = Maple.layer({
	serviceName: "maple-web",
	endpoint: ingestUrl,
	ingestKey: import.meta.env.VITE_MAPLE_INGEST_KEY,
	environment: import.meta.env.MODE,
	serviceVersion: import.meta.env.VITE_COMMIT_SHA,
})

export const runtime = ManagedRuntime.make(
	mapleApiClientLayer.pipe(Layer.provideMerge(mapleOtelLayer)),
	{ memoMap: Atom.defaultMemoMap },
)
