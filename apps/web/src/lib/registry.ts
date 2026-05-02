import { Atom, scheduleTask } from "@/lib/effect-atom"
import { Layer } from "effect"
import { AtomRegistry } from "effect/unstable/reactivity"
import { MapleApiAtomClient } from "./services/common/atom-client"
import { mapleOtelLayer } from "./services/common/otel-layer"

// Make the Maple OTel tracer/logger/metrics available to every atom runtime.
// AtomHttpApi.Service builds its runtime via `Layer.provide(apiClientLayer,
// httpClient)` which CONSUMES outer services without exposing them to the
// runtime that actually executes requests — so HttpClient.execute would read
// the default NoopTracer instead of the OTLP tracer. `addGlobalLayer` injects
// our layer via `Layer.provideMerge`, which keeps Tracer in the runtime.
Atom.runtime.addGlobalLayer(mapleOtelLayer)

export const appRegistry = AtomRegistry.make({ scheduleTask })

export const sharedAtomRuntime = MapleApiAtomClient.runtime

appRegistry.mount(sharedAtomRuntime)

// Extract the typed layer from the AtomRuntime for imperative Effect.provide() usage
export const mapleApiClientLayer: Layer.Layer<MapleApiAtomClient> = appRegistry.get(
	MapleApiAtomClient.runtime.layer,
)
