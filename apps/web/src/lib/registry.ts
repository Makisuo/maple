import { scheduleTask } from "@/lib/effect-atom"
import { Layer } from "effect"
import { AtomRegistry } from "effect/unstable/reactivity"
import { MapleApiAtomClient } from "./services/common/atom-client"

export const appRegistry = AtomRegistry.make({ scheduleTask })

export const sharedAtomRuntime = MapleApiAtomClient.runtime

appRegistry.mount(sharedAtomRuntime)

// Extract the typed layer from the AtomRuntime for imperative Effect.provide() usage
export const mapleApiClientLayer: Layer.Layer<MapleApiAtomClient> = appRegistry.get(
	MapleApiAtomClient.runtime.layer,
)
