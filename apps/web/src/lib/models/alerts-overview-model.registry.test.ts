/**
 * Registry-level test for the alerts model's rule-toggle write. Rather than
 * stand up the whole overview model (Electric collections + the delivery query),
 * it wraps the extracted {@link toggleRuleHandler} in a minimal model and drives
 * it through the unitflow registry — the testing story from
 * https://unitflow.space/testing/ (Registry.layer + Model.get +
 * Mutation.call/Event.emit + Registry.allSettled), with a fake API client.
 */

import { assert, describe, it } from "@effect/vitest"
import { Exit, Layer, Schema } from "effect"
import * as Effect from "effect/Effect"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import { vi } from "vitest"

import { AlertRuleDocument, type AlertRuleUpsertRequest } from "@maple/domain/http"
import { Event, Model, Mutation, Registry, Store } from "@maple/unitflow"

// Importing the model pulls in the atom client / collections, which load
// @/lib/registry (a ManagedRuntime) at module init. Stub it — this test
// provides its own fake MapleApiAtomClient.
vi.mock("@/lib/registry", () => ({ mapleRuntime: {}, mapleApiClientLayer: Layer.empty }))

import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { toggleRuleHandler } from "./alerts-overview-model"

const decodeRule = Schema.decodeUnknownSync(AlertRuleDocument)
const RULE_A = "00000000-0000-4000-8000-00000000000a"
const RULE_B = "00000000-0000-4000-8000-00000000000b"

const makeRule = (overrides: Record<string, unknown> = {}): AlertRuleDocument =>
	decodeRule({
		id: RULE_A,
		name: "My rule",
		notes: null,
		notificationTemplate: null,
		enabled: true,
		severity: "warning",
		serviceNames: [],
		excludeServiceNames: [],
		tags: [],
		groupBy: null,
		signalType: "error_rate",
		comparator: "gt",
		threshold: 0.05,
		thresholdUpper: null,
		windowMinutes: 5,
		minimumSampleCount: 0,
		consecutiveBreachesRequired: 2,
		consecutiveHealthyRequired: 2,
		renotifyIntervalMinutes: 30,
		metricName: null,
		metricType: null,
		metricAggregation: null,
		apdexThresholdMs: null,
		queryBuilderDraft: null,
		rawQuerySql: null,
		rawQueryReducer: null,
		destinationIds: ["00000000-0000-4000-8000-00000000dddd"],
		noDataBehavior: "skip",
		lastEvaluationError: null,
		lastEvaluatedAt: "2026-07-06T11:59:00.000Z",
		lastScheduledAt: "2026-07-06T11:59:00.000Z",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		createdBy: "user_test",
		updatedBy: "user_test",
		...overrides,
	})

interface UpdateRuleReq {
	readonly params: { readonly ruleId: string }
	readonly payload: AlertRuleUpsertRequest
}

/**
 * A fake MapleApiAtomClient exposing only `alerts.updateRule` (all the handler
 * touches), recording every call. The real client is a large generated
 * HttpApiClient, so the stub is narrowed with one test-only boundary cast.
 */
const makeFakeClient = (respond: (req: UpdateRuleReq) => Effect.Effect<AlertRuleDocument, Error>) => {
	const calls: UpdateRuleReq[] = []
	const client = {
		alerts: {
			updateRule: (req: UpdateRuleReq) => {
				calls.push(req)
				return respond(req)
			},
		},
	}
	// biome-ignore lint/suspicious/noExplicitAny: narrow test double for a large generated client
	const layer = Layer.succeed(MapleApiAtomClient, client as any)
	return { calls, layer }
}

/** Minimal model whose only port is the real toggle mutation handler. */
class ToggleTestModel extends Model.Service<ToggleTestModel>()("test/alerts/toggle")({
	make: () =>
		Effect.gen(function* () {
			const toggle = yield* Mutation.make(toggleRuleHandler)
			return {
				inputs: { toggle: toggle.run },
				outputs: { done: toggle.done },
				ui: { toggle: toggle.run, state: toggle.state },
			}
		}),
}) {}

const layerFor = (fake: { readonly layer: Layer.Layer<MapleApiAtomClient> }) =>
	ToggleTestModel.layer.pipe(
		Layer.provideMerge(Reactivity.layer),
		Layer.provideMerge(fake.layer),
		Layer.provideMerge(Registry.layer),
	)

describe("AlertsOverviewModel toggle mutation", () => {
	it.effect("calls updateRule with the flipped `enabled` and lands success", () => {
		const fake = makeFakeClient((req) =>
			Effect.succeed(makeRule({ id: req.params.ruleId, enabled: req.payload.enabled })),
		)
		return Effect.gen(function* () {
			const ports = yield* Model.get(ToggleTestModel)
			const updated = yield* Mutation.call(ports.inputs.toggle, makeRule({ id: RULE_A, enabled: true }))

			assert.strictEqual(updated.enabled, false)
			assert.strictEqual(fake.calls.length, 1)
			assert.strictEqual(fake.calls[0]?.params.ruleId, RULE_A)
			assert.strictEqual(fake.calls[0]?.payload.enabled, false)

			const state = yield* Store.get(ports.ui.state)
			assert.strictEqual(AsyncResult.isSuccess(state), true)
		}).pipe(Effect.provide(layerFor(fake)))
	})

	it.effect("records a failed toggle in `state` and surfaces the typed error", () => {
		const fake = makeFakeClient(() => Effect.fail(new Error("nope")))
		return Effect.gen(function* () {
			const ports = yield* Model.get(ToggleTestModel)
			const exit = yield* Mutation.call(ports.inputs.toggle, makeRule()).pipe(Effect.exit)

			assert.strictEqual(Exit.isFailure(exit), true)
			const state = yield* Store.get(ports.ui.state)
			assert.strictEqual(AsyncResult.isFailure(state), true)
		}).pipe(Effect.provide(layerFor(fake)))
	})

	it.effect("serializes fire-and-forget toggles on one permit, in order", () => {
		const fake = makeFakeClient((req) =>
			Effect.succeed(makeRule({ id: req.params.ruleId, enabled: req.payload.enabled })),
		)
		return Effect.gen(function* () {
			const ports = yield* Model.get(ToggleTestModel)
			yield* Registry.allSettled(
				Event.emit(ports.inputs.toggle, makeRule({ id: RULE_A })),
				Event.emit(ports.inputs.toggle, makeRule({ id: RULE_B })),
			)
			assert.strictEqual(fake.calls.length, 2)
			assert.strictEqual(fake.calls[0]?.params.ruleId, RULE_A)
			assert.strictEqual(fake.calls[1]?.params.ruleId, RULE_B)
		}).pipe(Effect.provide(layerFor(fake)))
	})
})
