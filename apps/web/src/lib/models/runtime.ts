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

import { Debug, UnitflowRuntime } from "@maple/unitflow"
import { Layer } from "effect"
import * as Exit from "effect/Exit"
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

// Dev-only: attach the unitflow debug inspector to the shared registry so the
// devtools panel can read the event/causality log and live store+instance
// snapshot. Attach eagerly at module load — BEFORE any View mounts and leases a
// model — so the inspector's port directory is populated at construction. The
// registry lives inside the runtime's layer; `runSyncExit` builds it and
// resolves the inspector synchronously when the layer is synchronous (it is),
// falling back to an async attach if that ever changes. The inspector is a
// passive tap (one property check on the hot paths), never installed in prod.
let unitflowInspector: Debug.Inspector | undefined
if (import.meta.env.DEV && typeof window !== "undefined") {
	const attach = Debug.attach({ capacity: 5000 })
	// `Debug.attach` resolves the Registry and THEN installs the sink
	// (`attachTo`), which is idempotent — a repeat attach just replaces the
	// sink, with no subscription to leak. Because `attachTo` runs only after the
	// Registry layer is built, a sync attempt that fails on an async layer build
	// never partially attached, so the async fallback attaches exactly once.
	// (Today the layer is synchronous, so the sync path wins and the fallback is
	// purely defensive against a future async layer.)
	try {
		const attached = unitflowRuntime.runtime.runSyncExit(attach)
		if (Exit.isSuccess(attached)) {
			unitflowInspector = attached.value
		} else {
			void unitflowRuntime.runtime.runPromise(attach).then((inspector) => {
				unitflowInspector = inspector
			})
		}
	} catch {
		void unitflowRuntime.runtime.runPromise(attach).then((inspector) => {
			unitflowInspector = inspector
		})
	}
}

/** The unitflow debug inspector, in dev only (undefined in prod or before the
 * runtime layer finishes building). Read by the devtools panel. */
export const getUnitflowInspector = (): Debug.Inspector | undefined => unitflowInspector

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
