/**
 * The alerts-overview unit: rules + live evaluation states + incidents (three
 * Electric-synced collections) + delivery events (HTTP query) combined into
 * one derived rules-with-status view. This is the unitflow pilot — the
 * derivation that used to run as a useMemo pyramid on every render of
 * `AlertsOverviewTab` now recomputes only when a source emits, and lives
 * outside the component tree (importable from a non-React runtime).
 *
 * URL-backed filters, session/destination atoms, and the toggle mutation stay
 * in the component — they are routing/React concerns, not model state.
 */

import type {
	AlertDeliveryEventDocument,
	AlertIncidentDocument,
	AlertRuleDocument,
} from "@maple/domain/http"
import { Event, Model, Query, Registry, Store } from "@maple/unitflow"
import * as Db from "@maple/unitflow/db"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { Reactivity } from "effect/unstable/reactivity/Reactivity"

import { deriveRuleStatus, type DerivedRuleStatus, needsAttention } from "@/lib/alerts/rule-status"
import {
	type AlertIncidentRow,
	type AlertRuleRow,
	type AlertRuleStateRow,
	buildRuleStatesByRuleId,
	rowToAlertIncidentDocument,
	rowToAlertRuleDocument,
} from "@/lib/collections/alerts"
import {
	getCollectionsGeneration,
	getOrgCollections,
	subscribeCollectionsGeneration,
} from "@/lib/collections/org-collections"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { getActiveOrgId, subscribeActiveOrgId } from "@/lib/services/common/auth-headers"

const DAY_MS = 24 * 60 * 60 * 1000

/** How often the wall-clock input of the staleness derivation advances. */
const CLOCK_TICK = "30 seconds"

export interface AlertsHealthCounts {
	firing: number
	attention: number
	healthy: number
	disabled: number
}

/** The fully derived overview — everything the tab renders per rule. */
export interface AlertsOverviewReady {
	readonly phase: "ready"
	readonly rules: ReadonlyArray<AlertRuleDocument>
	readonly incidents: ReadonlyArray<AlertIncidentDocument>
	readonly openIncidents: ReadonlyArray<AlertIncidentDocument>
	readonly statesByRule: Map<string, AlertRuleStateRow[]>
	readonly incidentsByRule: Map<string, AlertIncidentDocument[]>
	readonly derivedByRuleId: Map<string, DerivedRuleStatus>
	readonly healthCounts: AlertsHealthCounts
	readonly timelineRange: { readonly min: number; readonly max: number }
}

/** The derived overview, in the phases the tab renders distinctly. */
export type AlertsOverviewData =
	| { readonly phase: "loading" }
	| { readonly phase: "error"; readonly message: string }
	| AlertsOverviewReady

export interface OverviewInputs {
	readonly rules: ReadonlyArray<AlertRuleDocument>
	readonly incidents: ReadonlyArray<AlertIncidentDocument>
	readonly states: ReadonlyArray<AlertRuleStateRow>
	readonly deliveryEvents: ReadonlyArray<AlertDeliveryEventDocument>
	readonly now: number
}

const groupByRuleId = <T extends { readonly ruleId: string }>(items: ReadonlyArray<T>): Map<string, T[]> => {
	const map = new Map<string, T[]>()
	for (const item of items) {
		const list = map.get(item.ruleId)
		if (list) list.push(item)
		else map.set(item.ruleId, [item])
	}
	return map
}

/**
 * The whole overview derivation as one pure function over domain documents —
 * unit-testable without React or a registry. Replaces the useMemo chain the
 * overview tab used to run per render.
 */
export const deriveOverview = (inputs: OverviewInputs): AlertsOverviewReady => {
	const { now } = inputs
	// ISO timestamps order lexicographically; newest first, as the server lists do.
	const byIsoDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0)
	const rules = [...inputs.rules].sort((a, b) => byIsoDesc(a.updatedAt, b.updatedAt))
	const incidents = [...inputs.incidents].sort((a, b) => byIsoDesc(a.lastTriggeredAt, b.lastTriggeredAt))

	const openIncidents = incidents.filter((incident) => incident.status === "open")
	const incidentsByRule = groupByRuleId(incidents)
	const openIncidentsByRule = groupByRuleId(openIncidents)
	// The delivery-events list arrives newest-first; deriveRuleStatus relies on it.
	const deliveriesByRule = groupByRuleId(inputs.deliveryEvents)

	const statesByRule = new Map<string, AlertRuleStateRow[]>()
	for (const state of inputs.states) {
		const list = statesByRule.get(state.rule_id)
		if (list) list.push(state)
		else statesByRule.set(state.rule_id, [state])
	}

	const derivedByRuleId = new Map<string, DerivedRuleStatus>()
	const healthCounts: AlertsHealthCounts = { firing: 0, attention: 0, healthy: 0, disabled: 0 }
	for (const rule of rules) {
		const derived = deriveRuleStatus({
			rule,
			states: statesByRule.get(rule.id) ?? [],
			openIncidents: openIncidentsByRule.get(rule.id) ?? [],
			deliveryEvents: deliveriesByRule.get(rule.id) ?? [],
			now,
		})
		derivedByRuleId.set(rule.id, derived)
		if (derived.status === "firing") healthCounts.firing++
		else if (derived.status === "healthy") healthCounts.healthy++
		else if (derived.status === "disabled") healthCounts.disabled++
		if (needsAttention(derived)) healthCounts.attention++
	}

	return {
		phase: "ready",
		rules,
		incidents,
		openIncidents,
		statesByRule,
		incidentsByRule,
		derivedByRuleId,
		healthCounts,
		timelineRange: { min: now - DAY_MS, max: now },
	}
}

interface OverviewSources {
	readonly rules: Db.CollectionState<AlertRuleRow>
	readonly states: Db.CollectionState<AlertRuleStateRow>
	readonly incidents: Db.CollectionState<AlertIncidentRow>
	readonly deliveries: ReadonlyArray<AlertDeliveryEventDocument>
	readonly now: number
}

const collectionFailureMessage = <T>(state: Db.CollectionState<T>): string | null => {
	if (!AsyncResult.isFailure(state)) return null
	for (const reason of state.cause.reasons) {
		if (Cause.isFailReason(reason)) return reason.error.message
	}
	return "Collection failed to load"
}

/** Row-level combine body: phase handling + row→document, then {@link deriveOverview}. */
const buildOverview = (sources: OverviewSources): AlertsOverviewData => {
	const message =
		collectionFailureMessage(sources.rules) ??
		collectionFailureMessage(sources.states) ??
		collectionFailureMessage(sources.incidents)
	if (message !== null) {
		return { phase: "error", message }
	}
	if (!AsyncResult.isSuccess(sources.rules) || !AsyncResult.isSuccess(sources.incidents)) {
		return { phase: "loading" }
	}

	const stateRows = AsyncResult.isSuccess(sources.states) ? sources.states.value : []
	const evaluationStateByRule = buildRuleStatesByRuleId(stateRows)
	return deriveOverview({
		rules: sources.rules.value.map((row) => rowToAlertRuleDocument(row, evaluationStateByRule)),
		incidents: sources.incidents.value.map(rowToAlertIncidentDocument),
		states: stateRows,
		deliveryEvents: sources.deliveries,
		now: sources.now,
	})
}

const orgIdOf = (key: string): string => key.slice(0, key.lastIndexOf(":"))

/**
 * `${orgId}:${generation}` — the composite the hook path encoded in its
 * useMemo deps. An org switch or a schema-self-heal generation bump changes
 * the key; `Db.fromCollectionByKey` then switches to the freshly minted
 * collections and the old subscriptions drain (`cleanupCollectionWhenIdle`
 * tears the superseded shape streams down once subscriberCount hits 0).
 */
const makeOrgCollectionsKey: Effect.Effect<Store.Store<string>, never, Registry> = Effect.gen(function* () {
	const currentKey = () => `${getActiveOrgId() ?? "pending"}:${getCollectionsGeneration()}`
	const store = Store.make(currentKey())
	yield* Registry.run(
		Stream.callback<string>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const push = () => Queue.offerUnsafe(queue, currentKey())
					const unsubscribes = [subscribeActiveOrgId(push), subscribeCollectionsGeneration(push)]
					push()
					return unsubscribes
				}),
				(unsubscribes) =>
					Effect.sync(() => {
						for (const unsubscribe of unsubscribes) unsubscribe()
					}),
			),
		).pipe(
			// The acquire re-offers the current key to close the subscribe race, and
			// Store.set does not dedupe — dropping unchanged keys here keeps that
			// re-offer (and any same-key publish) from reloading dependent queries.
			Stream.mapEffect((key) =>
				Effect.gen(function* () {
					if ((yield* Store.get(store)) !== key) yield* Store.set(store, key)
				}),
			),
		),
	)
	return store
})

export class AlertsOverviewModel extends Model.Service<AlertsOverviewModel>()("maple/alerts/overview")({
	// Not the singleton default (keepAlive): the instance — 3 shape-stream
	// subscriptions, the delivery-events query, and the clock tick — should not
	// stay live for the whole app session once the user leaves /alerts. The idle
	// TTL keeps state warm across quick tab switches and back-navigation, then
	// drains everything after the last View unmounts.
	lifetime: { idleTimeToLive: "5 minutes" },
	make: () =>
		Effect.gen(function* () {
			const orgKey = yield* makeOrgCollectionsKey
			const rules = yield* Db.fromCollectionByKey(orgKey, (key) => getOrgCollections(orgIdOf(key)).alertRules)
			const states = yield* Db.fromCollectionByKey(
				orgKey,
				(key) => getOrgCollections(orgIdOf(key)).alertRuleStates,
			)
			const incidents = yield* Db.fromCollectionByKey(
				orgKey,
				(key) => getOrgCollections(orgIdOf(key)).alertIncidents,
			)

			// Delivery events stay an HTTP read (no Electric shape) — refetched on
			// org/generation change via the dependency store, manually via `refresh`.
			const deliveryEvents = yield* Query.make({
				stores: { orgKey },
				handler: () =>
					Effect.gen(function* () {
						const client = yield* MapleApiAtomClient
						return yield* client.alerts.listDeliveryEvents()
					}),
			})

			// Atom mutations invalidate `reactivityKeys: ["alertDeliveryEvents"]`
			// (test-notification flows). The runtime shares the atom world's
			// Reactivity instance (see models/runtime.ts), so those invalidations
			// re-trigger this query exactly like the old atom-based fetch did.
			const reactivity = yield* Reactivity
			yield* Registry.run(
				reactivity.stream(["alertDeliveryEvents"], Effect.void).pipe(
					// The stream emits once on subscribe; only invalidations refetch.
					Stream.drop(1),
					Stream.mapEffect(() => Event.emit(deliveryEvents.refresh)),
				),
			)

			// The staleness derivation compares against wall clock; advance it on a
			// coarse tick so a rule can go stale without any source emitting.
			const clock = Store.make(Date.now())
			yield* Registry.run(Stream.tick(CLOCK_TICK).pipe(Stream.mapEffect(() => Store.set(clock, Date.now()))))

			const overview = Store.combine(
				[rules, states, incidents, deliveryEvents.state, clock],
				(rulesState, statesState, incidentsState, deliveriesState, now) =>
					buildOverview({
						rules: rulesState,
						states: statesState,
						incidents: incidentsState,
						// Failed/loading deliveries degrade to [] — same as the tab's orElse.
						deliveries: AsyncResult.isSuccess(deliveriesState) ? deliveriesState.value.events : [],
						now,
					}),
			)

			return {
				inputs: { refreshDeliveries: deliveryEvents.refresh },
				outputs: { overview },
				ui: { overview, refreshDeliveries: deliveryEvents.refresh },
			}
		}),
}) {}
