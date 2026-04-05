import { Layer, ManagedRuntime } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { Maple } from "@maple-dev/effect-sdk/client"
import { MapleApiAtomClient } from "./atom-client"
import { ingestUrl } from "./ingest-url"

// TODO: wire into runtimeLayer once ready
export const mapleOtelLayer = Maple.layer({
  serviceName: "maple-web",
  endpoint: ingestUrl,
  ingestKey: import.meta.env.VITE_MAPLE_INGEST_KEY,
  environment: import.meta.env.MODE,
  serviceVersion: import.meta.env.VITE_COMMIT_SHA,
})

export const runtimeLayer = Layer.merge(MapleApiAtomClient.layer, Layer.empty)

export const runtime = ManagedRuntime.make(MapleApiAtomClient.layer, { memoMap: Atom.defaultMemoMap })
