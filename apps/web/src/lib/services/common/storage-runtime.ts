import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import { Atom } from "effect/unstable/reactivity"

export const localStorageRuntime = Atom.runtime(KeyValueStore.layerStorage(() => localStorage))
