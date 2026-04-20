import * as BrowserKeyValueStore from "@effect/platform-browser/BrowserKeyValueStore"
import { describe } from "@effect/vitest"
import { testLayer } from "effect-test/unstable/persistence/KeyValueStore.test"

describe("KeyValueStore / layerLocalStorage", () => testLayer(BrowserKeyValueStore.layerLocalStorage))

describe("KeyValueStore / layerSessionStorage", () => testLayer(BrowserKeyValueStore.layerSessionStorage))
