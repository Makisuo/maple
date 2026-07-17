/**
 * The alerts-overview unit: rules + live evaluation states + incidents (three
 * Electric-synced collections) + delivery events (HTTP query) combined into
 * one derived rules-with-status view. This is the unitflow pilot — the
 * derivation that used to run as a useMemo pyramid on every render of
 * `AlertsOverviewTab` now recomputes only when a source emits, and lives
 * outside the component tree (importable from a non-React runtime).
 *
 * URL-backed filters and the session/destination atoms stay in the component —
 * they are routing/React concerns. The rule enable/disable toggle is a
 * model-owned `Mutation` (see `toggleRule` below), so the write and its
 * in-flight state live with the data they mutate.
 */

import type {
	AlertDeliveryEventDocument,
	AlertIncidentDocument,
	AlertRuleDocument,
} from "@maple/domain/http"
import { Event, Model, Mutation, Query, Registry, Store } from "@maple/unitflow"
import * as Db from "@maple/unitflow/db"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
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
import { getOrgCollections } from "@/lib/collections/org-collections"
import { collectionFailureMessage, makeOrgCollectionsKey, orgIdOf } from "@/lib/models/org-collections-key"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Oldest resolved incident the overview still processes — the widest window any
 * consumer renders (the summary strip's 30d "Triggered" count). The synced
 * collection holds the org's full incident history; without this cutoff every
 * derivation re-sorts and re-groups an ever-growing set, which is what
 * gradually locked up the tab during long firing stretches. Open incidents are
 * always kept.
 */
const INCIDENT_WINDOW_MS = 30 * DAY_MS

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
	const incidentCutoff = now - INCIDENT_WINDOW_MS
	const incidents = inputs.incidents
		.filter((incident) => incident.status === "open" || Date.parse(incident.lastTriggeredAt) >= incidentCutoff)
		.sort((a, b) => byIsoDesc(a.lastTriggeredAt, b.lastTriggeredAt))

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

/** Row-level combine body: phase handling + row→document, then {@link deriveOverview}. */
const buildOverview = (sources: OverviewSources): AlertsOverviewData => {
	// Rules + incidents gate the page — for BOTH error and loading. Evaluation
	// states are secondary/derived (the old tab read them via useAlertRuleStates,
	// which had no error channel and degraded to []): a failing states shape must
	// not blank the overview, it falls back to the rule doc's lastEvaluation* fields.
	const message =
		collectionFailureMessage(sources.rules) ?? collectionFailureMessage(sources.incidents)
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

/**
 * The rule enable/disable write, factored out of the model so it is testable
 * through the registry without standing up the full overview model (collections
 * + delivery query). Wrapping the PATCH in `reactivity.mutation(["alertRules"])`
 * keeps atom-world alertRules readers in sync; the model's own alertRules
 * Electric shape self-updates regardless.
 */
export const toggleRuleHandler = (rule: AlertRuleDocument) =>
	Effect.gen(function* () {
		const reactivity = yield* Reactivity
		const client = yield* MapleApiV2AtomClient
		return yield* reactivity.mutation(
			["alertRules"],
			client.alertRules.update({
				params: { id: rule.id },
				payload: { enabled: !rule.enabled },
			}),
		)
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
			// TODO(v2): also the last v1 alerts endpoint the web app calls — no v2
			// equivalent exists; the follow-up is an alert_delivery_events Electric shape.
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

			// The rule enable/disable toggle is a model-owned write. `Mutation.make`
			// serializes it on one permit and exposes a `state` the switch reflects
			// while the PATCH is in flight. The handler is {@link toggleRuleHandler}
			// (factored out so it is testable through the registry).
			const toggleRule = yield* Mutation.make(toggleRuleHandler)

			// The staleness derivation compares against wall clock; advance it on a
			// coarse tick so a rule can go stale without any source emitting.
			const clock = Store.make(yield* Clock.currentTimeMillis)
			yield* Registry.run(
				Stream.tick(CLOCK_TICK).pipe(
					Stream.mapEffect(() => Effect.flatMap(Clock.currentTimeMillis, (ms) => Store.set(clock, ms))),
				),
			)

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
				inputs: { refreshDeliveries: deliveryEvents.refresh, toggleRule: toggleRule.run },
				outputs: { overview },
				ui: {
					overview,
					refreshDeliveries: deliveryEvents.refresh,
					toggleRule: toggleRule.run,
					toggleState: toggleRule.state,
				},
			}
		}),
}) {}
