// BOUNDARY: The fake HTTP service models JSON documents owned by the Maple API.
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, Redacted, Schema } from "effect"
import { adopt } from "alchemy/AdoptPolicy"
import { renamedFrom } from "alchemy/Rename"
import * as Core from "alchemy/Test/Core"
import * as Provider from "alchemy/Provider"
import * as State from "alchemy/State"
import { sync } from "alchemy/Sync"
import { ApiKey, ApiKeyProvider } from "../src/ApiKey"
import { Dashboard, DashboardProvider } from "../src/Dashboard"
import { AlertRule, AlertRuleProvider, type AlertRuleProps } from "../src/AlertRule"
import { AlertDestination, AlertDestinationProvider } from "../src/AlertDestination"
import { Providers } from "../src/Providers"
import { MapleApi, type MapleApiContract } from "../src/MapleApi"
import { makeMapleApiResponseError, MapleErrorTags } from "../src/errors"
import { V2AlertRuleCreateParams } from "@maple/domain/http/v2"

type Document = Record<string, unknown> & { id: string; name: string }
const decodeBody = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))

const makeHarness = () => {
	const documents = new Map<string, Document>()
	const calls: Array<{ method: string; path: string; body?: unknown }> = []
	let sequence = 0
	const collectionPath = (path: string) => path.slice(0, path.lastIndexOf("/"))
	const missing = (path: string) =>
		makeMapleApiResponseError(404, {
			_tag: path.startsWith("/v2/api_keys/")
				? MapleErrorTags.apiKeyNotFound
				: path.startsWith("/v2/dashboards/")
					? MapleErrorTags.dashboardNotFound
					: path.startsWith("/v2/alerts/rules/")
						? MapleErrorTags.alertRuleNotFound
						: MapleErrorTags.alertDestinationNotFound,
			type: "not_found_error",
			code: "resource_missing",
			title: "Not found",
			message: path,
			retryable: false,
			recovery: "none",
		})
	const insert = (path: string, body: Record<string, unknown>) => {
		const id = `item_${++sequence}`
		const document: Document = {
			id,
			name: String(body.name),
			description: null,
			tags: [],
			time_range: { type: "relative", value: "12h" },
			widgets: [],
			sections: [],
			variables: [],
			enabled: true,
			channel_label: null,
			key_prefix: `maple_ak_${id}`,
			revoked: false,
			...body,
		}
		documents.set(`${path}/${id}`, structuredClone(document))
		return { ...structuredClone(document), secret: `maple_ak_secret_${id}` }
	}
	const api: MapleApiContract = {
		get: (path) =>
			Effect.suspend((): ReturnType<MapleApiContract["get"]> => {
				calls.push({ method: "GET", path })
				if (path.includes("?"))
					return Effect.succeed({
						data: [...documents.entries()]
							.filter(([key]) => collectionPath(key) === path.split("?")[0])
							.map(([, doc]) => structuredClone(doc)),
						has_more: false,
						next_cursor: null,
					})
				const doc = documents.get(path)
				return doc ? Effect.succeed(structuredClone(doc)) : Effect.fail(missing(path))
			}),
		post: (path, body) =>
			Effect.suspend(() => {
				calls.push({ method: "POST", path, body })
				if (path.endsWith("/roll")) {
					const old = documents.get(path.slice(0, -5))
					if (!old) return Effect.fail(missing(path))
					const { id: _id, key_prefix: _prefix, ...props } = old
					const next = insert("/v2/api_keys", props)
					old.revoked = true
					return Effect.succeed(next)
				}
				return Effect.succeed(insert(path, decodeBody(body)))
			}),
		patch: (path, body) =>
			Effect.suspend(() => {
				calls.push({ method: "PATCH", path, body })
				const old = documents.get(path)
				if (!old) return Effect.fail(missing(path))
				const next = { ...old, ...decodeBody(body) }
				documents.set(path, structuredClone(next))
				return Effect.succeed(structuredClone(next))
			}),
		delete: (path) =>
			Effect.suspend(() => {
				calls.push({ method: "DELETE", path })
				const old = documents.get(path)
				if (!old) return Effect.fail(missing(path))
				if (path.startsWith("/v2/api_keys/")) old.revoked = true
				else documents.delete(path)
				return Effect.void
			}),
	}
	const providers = Layer.effect(
		Providers,
		Provider.collection([ApiKey, Dashboard, AlertRule, AlertDestination]),
	).pipe(
		Layer.provide(
			Layer.mergeAll(
				ApiKeyProvider(),
				DashboardProvider(),
				AlertRuleProvider(),
				AlertDestinationProvider(),
			),
		),
		Layer.provide(Layer.succeed(MapleApi, api)),
	)
	const options = { providers, state: State.inMemoryState(), stage: "test", adopt: false, dev: false }
	return {
		calls,
		documents,
		insert,
		stack: (name: string, stage = "test") => Core.scratchStack({ ...options, stage }, name),
		run: <A>(effect: Core.TestEffect<A>) => Core.toEffect(effect, options),
		sync: (stack: Core.ScratchStack, stage = "test", dryRun = false) =>
			Core.withProviders(
				sync({ name: stack.name, stage }, { dryRun }).pipe(Effect.provide(stack.state)),
				{ ...options, stage },
				stack.name,
			),
	}
}

const ruleProps: AlertRuleProps = {
	name: "Checkout errors",
	severity: "critical",
	signal_type: "error_rate",
	comparator: "gt",
	threshold: 0.05,
	window_minutes: 5,
	destination_ids: [],
}

describe("Alchemy engine lifecycle", () => {
	it.live("preserves rule ownership during an explicit logical rename", () => {
		const h = makeHarness()
		const stack = h.stack("rename")
		return h.run(
			Effect.gen(function* () {
				const original = yield* stack.deploy(AlertRule("old-id", ruleProps))
				const renamed = yield* stack.deploy(
					AlertRule("new-id", ruleProps).pipe(renamedFrom("old-id")),
				)
				expect(renamed.ruleId).toBe(original.ruleId)
				expect(renamed.configuration?.tags).not.toEqual(original.configuration?.tags)
				yield* stack.destroy()
				expect(h.documents.has(`/v2/alerts/rules/${original.ruleId}`)).toBe(false)
			}),
		)
	})
	it.live(
		"replaces an API key when upstream outputs change, applying reduced scopes and revoking the old key",
		() => {
			const h = makeHarness()
			const stack = h.stack("keys")
			const program = (name: string, scopes?: string[]) =>
				Effect.gen(function* () {
					const dashboard = yield* Dashboard("name", { name })
					const key = yield* ApiKey("key", { name: dashboard.name, scopes })
					return { id: key.keyId, secret: key.secret }
				})
			return h.run(
				Effect.gen(function* () {
					const initial = yield* stack.deploy(program("old"))
					const plan = yield* stack.plan(program("new", ["dashboards:read"]))
					expect(plan.resources.key.action).toBe("replace")
					const updated = yield* stack.deploy(program("new", ["dashboards:read"]))
					expect(updated.id).not.toBe(initial.id)
					expect(Redacted.value(updated.secret)).not.toBe(Redacted.value(initial.secret))
					expect(h.documents.get(`/v2/api_keys/${updated.id}`)).toMatchObject({
						name: "new",
						scopes: ["dashboards:read"],
					})
					expect(h.documents.get(`/v2/api_keys/${initial.id}`)?.revoked).toBe(true)
					expect(
						(yield* stack.plan(program("new", ["dashboards:read"]))).resources.key.action,
					).toBe("noop")
				}),
			)
		},
	)

	it.live("keeps an unresolved rotate-only change on the roll path", () => {
		const h = makeHarness()
		const stack = h.stack("rotation")
		const program = (version: string) =>
			Effect.gen(function* () {
				const source = yield* Dashboard("rotation", { name: version })
				const key = yield* ApiKey("key", { name: "ci", rotate: source.name })
				return { id: key.keyId }
			})
		return h.run(
			Effect.gen(function* () {
				const initial = yield* stack.deploy(program("1"))
				expect((yield* stack.plan(program("2"))).resources.key.action).toBe("update")
				h.calls.length = 0
				yield* stack.deploy(program("2"))
				expect(h.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
					`/v2/api_keys/${initial.id}/roll`,
				])
			}),
		)
	})

	it.live("repairs declared dashboard content while ignoring timestamps and unmanaged fields", () => {
		const h = makeHarness()
		const stack = h.stack("dashboard")
		const props = {
			name: "Health",
			tags: ["golden"],
			widgets: [{ id: "w1", display: { title: "Latency" } }],
			sections: [],
		}
		return h.run(
			Effect.gen(function* () {
				const output = yield* stack.deploy(Dashboard("health", props))
				const doc = h.documents.get(`/v2/dashboards/${output.dashboardId}`)!
				doc.tags = ["wrong"]
				doc.widgets = []
				expect((yield* h.sync(stack, "test", true)).resources.health.action).toBe("drifted")
				expect((yield* h.sync(stack)).resources.health.action).toBe("repaired")
				expect(h.documents.get(`/v2/dashboards/${output.dashboardId}`)).toMatchObject({
					tags: props.tags,
					widgets: props.widgets,
				})
				const fresh = h.documents.get(`/v2/dashboards/${output.dashboardId}`)!
				fresh.description = "Edited outside IaC"
				fresh.updated_at = "2026-09-08T00:00:00Z"
				delete fresh.sections // API versions before sections should still converge.
				expect((yield* h.sync(stack)).resources.health.action).toBe("unchanged")
			}),
		)
	})

	it.live("repairs alert thresholds and destinations without reacting to evaluation timestamps", () => {
		const h = makeHarness()
		const stack = h.stack("rule-sync")
		return h.run(
			Effect.gen(function* () {
				const output = yield* stack.deploy(AlertRule("errors", ruleProps))
				const path = `/v2/alerts/rules/${output.ruleId}`
				Object.assign(h.documents.get(path)!, { threshold: 0.9, destination_ids: ["foreign"] })
				expect((yield* h.sync(stack, "test", true)).resources.errors.action).toBe("drifted")
				expect((yield* h.sync(stack)).resources.errors.action).toBe("repaired")
				expect(h.documents.get(path)).toMatchObject({ threshold: 0.05, destination_ids: [] })
				Object.assign(h.documents.get(path)!, {
					last_evaluated_at: "2026-09-08T00:00:00Z",
					notes: "Unmanaged",
				})
				expect((yield* h.sync(stack)).resources.errors.action).toBe("unchanged")
			}),
		)
	})

	it.live("recovers its own rule after lost state and rejects another stack or stage", () => {
		const h = makeHarness()
		return h.run(
			Effect.gen(function* () {
				const original = yield* h.stack("owner").deploy(AlertRule("errors", ruleProps))
				const recovered = yield* h.stack("owner").deploy(AlertRule("errors", ruleProps))
				expect(recovered.ruleId).toBe(original.ruleId)
				for (const other of [h.stack("other"), h.stack("owner", "production")]) {
					h.calls.length = 0
					const exit = yield* Effect.exit(
						other.deploy(AlertRule("errors", { ...ruleProps, threshold: 0.9 })),
					)
					expect(Exit.isFailure(exit)).toBe(true)
					expect(h.calls.every((call) => call.method === "GET")).toBe(true)
					yield* other.destroy()
					expect(h.documents.get(`/v2/alerts/rules/${original.ruleId}`)?.threshold).toBe(0.05)
				}
			}),
		)
	})

	it.live(
		"requires explicit adoption of unowned rules and protects them from the former owner after takeover",
		() => {
			const h = makeHarness()
			const original = h.insert("/v2/alerts/rules", { ...ruleProps, tags: ["keep"] })
			const owner = h.stack("adopter")
			return h.run(
				Effect.gen(function* () {
					expect(
						Exit.isFailure(yield* Effect.exit(owner.deploy(AlertRule("errors", ruleProps)))),
					).toBe(true)
					const adopted = yield* owner.deploy(AlertRule("errors", ruleProps).pipe(adopt(true)))
					expect(adopted.ruleId).toBe(original.id)
					const firstTags = h.documents.get(`/v2/alerts/rules/${original.id}`)!.tags
					expect(firstTags).toContain("keep")
					const taker = h.stack("takeover")
					yield* taker.deploy(
						AlertRule("errors", { ...ruleProps, threshold: 0.2 }).pipe(adopt(true)),
					)
					expect(h.documents.get(`/v2/alerts/rules/${original.id}`)!.tags).not.toEqual(firstTags)
					h.calls.length = 0
					expect(Exit.isFailure(yield* Effect.exit(owner.destroy()))).toBe(true)
					expect(h.calls.some((call) => call.method === "DELETE")).toBe(false)
					expect(h.documents.has(`/v2/alerts/rules/${original.id}`)).toBe(true)
					yield* taker.destroy()
					expect(h.documents.has(`/v2/alerts/rules/${original.id}`)).toBe(false)
				}),
			)
		},
	)

	it.live("checks ownership at apply when unresolved destination inputs prevent a plan-time read", () => {
		const h = makeHarness()
		const foreign = h.insert("/v2/alerts/rules", { ...ruleProps })
		const program = Effect.gen(function* () {
			const destination = yield* AlertDestination("hook", {
				type: "webhook",
				name: "Hook",
				url: "https://example.com/hook",
			})
			return yield* AlertRule("errors", { ...ruleProps, destination_ids: [destination.destinationId] })
		})
		return h.run(
			Effect.gen(function* () {
				const stack = h.stack("late-collision")
				expect((yield* stack.plan(program)).resources.errors.action).toBe("create")
				expect(Exit.isFailure(yield* Effect.exit(stack.deploy(program)))).toBe(true)
				expect(h.documents.get(`/v2/alerts/rules/${foreign.id}`)?.destination_ids).toEqual([])
				yield* stack.destroy()
				expect(h.documents.has(`/v2/alerts/rules/${foreign.id}`)).toBe(true)
			}),
		)
	})

	it.live("restores the default enabled state after removing false or an out-of-band disable", () => {
		const h = makeHarness()
		const stack = h.stack("destination-default")
		const props = { type: "webhook" as const, name: "Hook", url: "https://example.com/hook" }
		return h.run(
			Effect.gen(function* () {
				yield* stack.deploy(AlertDestination("hook", { ...props, enabled: false }))
				const output = yield* stack.deploy(AlertDestination("hook", props))
				expect(output.enabled).toBe(true)
				const path = `/v2/alerts/destinations/${output.destinationId}`
				h.documents.get(path)!.enabled = false
				expect((yield* h.sync(stack)).resources.hook.action).toBe("repaired")
				expect(h.documents.get(path)?.enabled).toBe(true)
				expect((yield* h.sync(stack)).resources.hook.action).toBe("unchanged")
			}),
		)
	})

	it.live(
		"resolves destination URLs and secrets from upstream outputs and replaces immutable channel types",
		() => {
			const h = makeHarness()
			const stack = h.stack("destination-inputs")
			const program = (url: string, rotate: number, pagerduty = false) =>
				Effect.gen(function* () {
					const source = yield* Dashboard("url", { name: url })
					const key = yield* ApiKey("secret", { name: "signing", rotate })
					const destination = yield* AlertDestination(
						"hook",
						pagerduty
							? { type: "pagerduty", name: "On call", integration_key: key.secret }
							: {
									type: "webhook",
									name: "On call",
									url: source.name,
									signing_secret: key.secret,
								},
					)
					return { destinationId: destination.destinationId, secret: key.secret }
				})
			return h.run(
				Effect.gen(function* () {
					const initial = yield* stack.deploy(program("https://example.com/old", 1))
					const updated = yield* stack.deploy(program("https://example.com/new", 2))
					expect(updated.destinationId).toBe(initial.destinationId)
					expect(h.documents.get(`/v2/alerts/destinations/${updated.destinationId}`)).toMatchObject(
						{
							url: "https://example.com/new",
							signing_secret: Redacted.value(updated.secret),
						},
					)
					expect(
						(yield* stack.plan(program("https://example.com/new", 3, true))).resources.hook
							.action,
					).toBe("replace")
					const replaced = yield* stack.deploy(program("https://example.com/new", 3, true))
					expect(replaced.destinationId).not.toBe(initial.destinationId)
					expect(h.documents.has(`/v2/alerts/destinations/${initial.destinationId}`)).toBe(false)
				}),
			)
		},
	)

	it.live("upgrades persisted resources from before snapshots and ownership without replacing them", () => {
		const h = makeHarness()
		const stack = h.stack("upgrade")
		const program = Effect.all({
			dashboard: Dashboard("health", { name: "Health", tags: ["golden"] }),
			rule: AlertRule("errors", ruleProps),
		})
		return h.run(
			Effect.gen(function* () {
				const initial = yield* stack.deploy(program)
				yield* Effect.gen(function* () {
					const state = yield* yield* State.State
					for (const fqn of ["health", "errors"]) {
						const row = yield* state.get({ stack: stack.name, stage: "test", fqn })
						expect(row).toHaveProperty("attr")
						if (row && "attr" in row) {
							const { configuration: _configuration, ...attr } = decodeBody(row.attr)
							yield* state.set({
								stack: stack.name,
								stage: "test",
								fqn,
								value: { ...row, attr },
							})
						}
					}
				}).pipe(Effect.provide(stack.state))
				h.documents.get(`/v2/alerts/rules/${initial.rule.ruleId}`)!.tags = []
				const plan = yield* stack.plan(program)
				expect(plan.resources.health.action).toBe("update")
				expect(plan.resources.errors.action).toBe("update")
				const upgraded = yield* stack.deploy(program)
				expect(upgraded.dashboard.dashboardId).toBe(initial.dashboard.dashboardId)
				expect(upgraded.rule.ruleId).toBe(initial.rule.ruleId)
				expect(upgraded.dashboard.configuration).toEqual({ name: "Health", tags: ["golden"] })
				expect(upgraded.rule.configuration?.tags).toEqual([
					expect.stringMatching(/^alchemy:[a-f0-9]{24}$/),
				])
				const next = yield* stack.plan(program)
				expect(next.resources.health.action).toBe("noop")
				expect(next.resources.errors.action).toBe("noop")
			}),
		)
	})

	it.live(
		"fits ownership into the API tag limits and rejects reserved or excess tags before writing",
		() => {
			const h = makeHarness()
			const stack = h.stack("tags")
			const tags = Array.from({ length: 19 }, (_, i) => `team-${i}`)
			return h.run(
				Effect.gen(function* () {
					yield* stack.deploy(AlertRule("errors", { ...ruleProps, tags }))
					const createdBody = h.calls.find((call) => call.method === "POST")!.body
					yield* Schema.decodeUnknownEffect(V2AlertRuleCreateParams)(createdBody)
					expect(decodeBody(createdBody).tags).toEqual([
						...tags,
						expect.stringMatching(/^alchemy:[a-f0-9]{24}$/),
					])
					for (const invalidTags of [[...tags, "overflow"], [" Alchemy:reserved "]]) {
						h.calls.length = 0
						expect(
							Exit.isFailure(
								yield* Effect.exit(
									stack.deploy(AlertRule("errors", { ...ruleProps, tags: invalidTags })),
								),
							),
						).toBe(true)
						expect(h.calls.every((call) => call.method === "GET")).toBe(true)
					}
				}),
			)
		},
	)
})
