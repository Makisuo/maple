import * as Context from "effect/Context"
import type { WorkerDev } from "@maple/alchemy-portless"
import type { DevApp } from "../dev-urls.ts"
import type { MapleDomains, MapleStage } from "./stage.ts"

/**
 * Public origins of the apps the others point at, as plan-time strings:
 * custom domains on deployed stages, portless routes under `bun dev`,
 * env-supplied (or empty) on a cloud-deployed dev stage.
 */
export interface MapleUrls {
	readonly api: string
	readonly ingest: string
	readonly electricSync: string
}

export interface MapleStackContext {
	readonly stage: MapleStage
	readonly domains: MapleDomains
	readonly urls: MapleUrls
	/** A Worker's `dev` block under `bun dev` (served, or left `external`); undefined on a deploy. */
	readonly workerDev: (app: DevApp) => WorkerDev | undefined
	/**
	 * Inter-app URLs handed to the Workers as env under `bun dev`, spread last
	 * so `.env.local` cannot override them; undefined on a deploy.
	 */
	readonly devEnv: Record<string, string> | undefined
}

/**
 * What the stack tells a single-module Worker (`main: import.meta.url`) about
 * the deploy it belongs to. The Worker's props Effect yields it; the root stack
 * provides it once, from `Alchemy.Stage`. Plan-time only: a Worker reads it
 * behind its `__ALCHEMY_RUNTIME__` guard, so it never has to exist in an isolate.
 */
export class MapleStack extends Context.Service<MapleStack, MapleStackContext>()("@maple/infra/MapleStack") {}
