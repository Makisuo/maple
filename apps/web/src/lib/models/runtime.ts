/**
 * The web app's unitflow runtime: model layers composed over the shared typed
 * API client layer (the same `mapleApiClientLayer` the imperative
 * `mapleRuntime` uses, so model queries carry auth + OTel like every other
 * call). One runtime for all models — mounted by the `<Unitflow>` root at the
 * routes that use models.
 */

import { UnitflowRuntime } from "@maple/unitflow"
import { Layer } from "effect"
import { mapleApiClientLayer } from "@/lib/registry"
import { AlertsOverviewModel } from "./alerts-overview-model"

export const unitflowRuntime = UnitflowRuntime.make(
	AlertsOverviewModel.layer.pipe(Layer.provideMerge(mapleApiClientLayer)),
)
