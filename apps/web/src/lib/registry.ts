import { Atom, scheduleTask } from "@/lib/effect-atom"
import { Layer } from "effect"
import { AtomRegistry } from "effect/unstable/reactivity"
import { MapleApiAtomClient } from "./services/common/atom-client"
import { MapleFetchHttpClientLive } from "./services/common/http-client"
import { mapleOtelLayer } from "./services/common/otel-layer"
import { MapleInternalAtomClient } from "./services/common/internal-atom-client"
import { MapleApiV2AtomClient } from "./services/common/v2-atom-client"
import { makeAppRuntime } from "./make-app-runtime"

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
export const appMemoMap = appRegistry.get(Atom.runtime.memoMap)

export const sharedAtomRuntime = MapleApiAtomClient.runtime

appRegistry.mount(sharedAtomRuntime)
appRegistry.mount(MapleApiV2AtomClient.runtime)
appRegistry.mount(MapleInternalAtomClient.runtime)

// Extract the typed layer from the AtomRuntime for imperative Effect.provide() usage
export const mapleApiClientLayer: Layer.Layer<MapleApiAtomClient> = appRegistry.get(
	MapleApiAtomClient.runtime.layer,
)

export const mapleApiV2ClientLayer: Layer.Layer<MapleApiV2AtomClient> = appRegistry.get(
	MapleApiV2AtomClient.runtime.layer,
)

export const mapleInternalClientLayer: Layer.Layer<MapleInternalAtomClient> = appRegistry.get(
	MapleInternalAtomClient.runtime.layer,
)

// One persistent ManagedRuntime built from both typed API layers, shared by every
// imperative (non-React) Effect run, including `runMapleApiV2` collection writes.
// Building it once avoids rebuilding the client layers on every call and gives the
// Effect-native collection factory a runtime for its handlers + backoff logging.
// Sharing the registry memo map is load-bearing: nested `Effect.provide` calls
// reuse the atom-owned client and tracer instances instead of rebuilding them.
export const mapleRuntime = makeAppRuntime(
	Layer.mergeAll(mapleApiClientLayer, mapleApiV2ClientLayer, mapleInternalClientLayer),
	appMemoMap,
)
