import * as Context from "effect/Context"
import type { WorkerDev } from "@maple/alchemy-portless"
import type { DevApp } from "../dev-urls.ts"
import type { MapleDomains, MapleStage } from "./stage.ts"

export interface MapleStackContext {
	readonly stage: MapleStage
	readonly domains: MapleDomains
	/** A Worker's `dev` block under `bun dev` (served, or left `external`); undefined on a deploy. */
	readonly workerDev: (app: DevApp) => WorkerDev | undefined
}

/**
 * What the stack tells a single-module Worker (`main: import.meta.url`) about
 * the deploy it belongs to. The Worker's props Effect yields it; the root stack
 * provides it once, from `Alchemy.Stage`. Plan-time only: a Worker reads it
 * behind its `__ALCHEMY_RUNTIME__` guard, so it never has to exist in an isolate.
 */
export class MapleStack extends Context.Service<MapleStack, MapleStackContext>()("@maple/infra/MapleStack") {}
