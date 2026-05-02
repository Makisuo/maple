import { Atom, scheduleTask } from "@/lib/effect-atom"
import { Layer } from "effect"
import { AtomRegistry } from "effect/unstable/reactivity"
import { MapleApiAtomClient } from "./services/common/atom-client"
import { MapleFetchHttpClientLive } from "./services/common/http-client"
import { mapleOtelLayer } from "./services/common/otel-layer"

// Register the fetch layer FIRST so the Effect Layer memoMap caches
// FetchHttpClient.layer with mapleFetch substituted. mapleOtelLayer's internal
// `Layer.provide(FetchHttpClient.layer)` will then reuse that memoized build —
// which means OTLP exporters also go through mapleFetch (mapleFetch's URL
// scoping keeps the Clerk JWT off ingest requests). Without this priming, the
// OTel layer's internal HttpClient build memoizes first with the default Fetch
// and api requests bypass mapleFetch entirely (no JWT → 401).
Atom.runtime.addGlobalLayer(MapleFetchHttpClientLive)
Atom.runtime.addGlobalLayer(mapleOtelLayer)

export const appRegistry = AtomRegistry.make({ scheduleTask })

export const sharedAtomRuntime = MapleApiAtomClient.runtime

appRegistry.mount(sharedAtomRuntime)

// Extract the typed layer from the AtomRuntime for imperative Effect.provide() usage
export const mapleApiClientLayer: Layer.Layer<MapleApiAtomClient> = appRegistry.get(
	MapleApiAtomClient.runtime.layer,
)
