/**
 * The web app's unitflow runtime: model layers composed over the shared typed
 * API client layer (the same `mapleApiClientLayer` the imperative
 * `mapleRuntime` uses, so model queries carry auth + OTel like every other
 * call). One runtime for all models — mounted by the `<Unitflow>` root at the
 * routes that use models.
 *
 * The runtime shares `Atom.runtime`'s layer memo map. That is load-bearing:
 * layers both worlds use — notably `Reactivity.layer` — build ONCE and resolve
 * the same instance, so `reactivityKeys` invalidations fired by atom mutations
 * (e.g. `useAtomSet(...mutation..., { reactivityKeys })`) are observable from
 * inside models. Without the shared memo map each runtime would construct its
 * own `Reactivity` and the two would be deaf to each other.
 */

import { UnitflowRuntime } from "@maple/unitflow"
import { Layer } from "effect"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import { Atom } from "@/lib/effect-atom"
import { mapleApiClientLayer } from "@/lib/registry"
import { AlertsOverviewModel } from "./alerts-overview-model"
import { DashboardsListModel } from "./dashboards-list-model"
import { ErrorIssuesModel } from "./error-issues-model"

export const unitflowRuntime = UnitflowRuntime.make(
	Layer.mergeAll(AlertsOverviewModel.layer, DashboardsListModel.layer, ErrorIssuesModel.layer).pipe(
		Layer.provideMerge(Layer.mergeAll(mapleApiClientLayer, Reactivity.layer)),
	),
	{ memoMap: Atom.runtime.memoMap },
)

// Dispose the runtime on page unload so every live model instance runs its
// finalizers (Electric shape subscriptions, the delivery-events query, the
// clock tick) instead of relying solely on the idle TTL — the cleanup the
// unitflow React binding calls for. Guarded for SSR / non-browser bundles;
// best-effort (the promise won't settle before the page tears down).
if (typeof window !== "undefined") {
	window.addEventListener("beforeunload", () => {
		void unitflowRuntime.dispose()
	})
}
