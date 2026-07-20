import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The self-heal guard is what we're testing; stub everything the module pulls in
// at import time so no real ManagedRuntime, atom registry, or Electric shape
// stream is created. Factory calls return a minimal collection stub (only
// `.cleanup()` is ever invoked on the previous set during a swap).
vi.mock("@/lib/registry", () => ({ mapleRuntime: { runFork: vi.fn() } }))
vi.mock("@/lib/services/common/auth-headers", () => ({
	getActiveOrgId: () => null,
	subscribeActiveOrgId: () => () => {},
}))

// Mirrors the SyncedCollectionLifecycle surface the cleanup scheduler uses:
// `subscriberCount`, `cleanup()`, and the `subscribers:change` event.
// `setSubscribers` is a test-only hook to simulate live queries attaching and
// draining.
const collectionStub = () => {
	const listeners = new Set<(event: { subscriberCount: number }) => void>()
	const stub = {
		subscriberCount: 0,
		cleanup: vi.fn(),
		on: (_event: string, callback: (event: { subscriberCount: number }) => void) => {
			listeners.add(callback)
			return () => listeners.delete(callback)
		},
		setSubscribers: (count: number) => {
			stub.subscriberCount = count
			for (const callback of [...listeners]) callback({ subscriberCount: count })
		},
	}
	return stub
}
type CollectionStub = ReturnType<typeof collectionStub>
// The mocked factories return stubs behind the real collection types; this
// reaches the stub's spy + test hooks.
const asStub = (collection: unknown) => collection as CollectionStub
vi.mock("./alerts", () => ({
	createAlertRulesCollection: collectionStub,
	createAlertRuleStatesCollection: collectionStub,
	createAlertIncidentsCollection: collectionStub,
	createAlertDestinationsCollection: collectionStub,
}))
vi.mock("./api-keys", () => ({ createApiKeysCollection: collectionStub }))
vi.mock("./dashboards", () => ({ createDashboardsCollection: collectionStub }))

// Each test wants isolated module state (generation counter + heal budget), so
// re-import a fresh copy. Importing registry in the same epoch first hands back
// the exact `runFork` spy the fresh org-collections module captured.
async function freshModule() {
	vi.resetModules()
	const registry = (await import("@/lib/registry")) as unknown as {
		mapleRuntime: { runFork: ReturnType<typeof vi.fn> }
	}
	const mod = await import("./org-collections")
	return { mod, runFork: registry.mapleRuntime.runFork }
}

describe("org-collections bounded self-heal", () => {
	beforeEach(() => {
		// The `vi.mock` factory's `vi.fn()` is memoized across `vi.resetModules()`,
		// so reset its call history between tests (implementation is preserved).
		vi.clearAllMocks()
		vi.useFakeTimers()
	})
	afterEach(() => vi.useRealTimers())

	it("recreates at most MAX_SCHEMA_HEAL_ATTEMPTS times, then gives up", async () => {
		const { mod, runFork } = await freshModule()
		const start = mod.getCollectionsGeneration()

		// Fire far more schema errors than the budget; advance past the cooldown
		// each time so a genuinely persistent drift gets every attempt it can.
		for (let i = 0; i < 12; i++) {
			mod.handleSchemaError()
			vi.advanceTimersByTime(6_000)
		}

		// 3 bounded recreations, then permanently stopped — not an infinite loop.
		expect(mod.getCollectionsGeneration()).toBe(start + 3)
		expect(runFork).toHaveBeenCalledTimes(1) // give-up logged exactly once
	})

	it("collapses a burst of errors into a single recreation", async () => {
		const { mod } = await freshModule()
		const start = mod.getCollectionsGeneration()

		// Several collections failing from one deploy fire back-to-back before any
		// timer runs — they must not each schedule their own recreation.
		mod.handleSchemaError()
		mod.handleSchemaError()
		mod.handleSchemaError()
		vi.advanceTimersByTime(6_000)

		expect(mod.getCollectionsGeneration()).toBe(start + 1)
	})

	it("stops after a single recreation when the drift heals (no give-up)", async () => {
		const { mod, runFork } = await freshModule()
		const start = mod.getCollectionsGeneration()

		// A transient post-deploy drift: the first recreate refetches fresh rows
		// and no further schema-error events arrive.
		mod.handleSchemaError()
		vi.advanceTimersByTime(6_000)

		expect(mod.getCollectionsGeneration()).toBe(start + 1)
		expect(runFork).not.toHaveBeenCalled()
	})

	it("cleans up an unsubscribed previous set immediately on org switch", async () => {
		const { mod } = await freshModule()

		const first = mod.getOrgCollections("org_a")
		const second = mod.getOrgCollections("org_b")
		expect(second).not.toBe(first)
		expect("scrapeTargetChecks" in first).toBe(false)

		// No live queries attached → nothing to wait for.
		expect(asStub(first.dashboards).cleanup).toHaveBeenCalledTimes(1)
		expect(asStub(first.apiKeys).cleanup).toHaveBeenCalledTimes(1)
		expect(asStub(first.alertRules).cleanup).toHaveBeenCalledTimes(1)
		// The new org's live set is untouched.
		expect(asStub(second.dashboards).cleanup).not.toHaveBeenCalled()
	})

	it("waits for a subscribed collection to drain before cleaning it up", async () => {
		const { mod } = await freshModule()

		const first = mod.getOrgCollections("org_a")
		// Simulate mounted consumers: live queries hold a subscription and only
		// release it after React re-renders onto the new org and the old
		// live-query collection GCs (~5s).
		asStub(first.dashboards).setSubscribers(2)

		mod.getOrgCollections("org_b")

		// Cleaning up now would log "[Live Query Error] Source collection ... was
		// manually cleaned up" and restart sync on the dead collection (zombie
		// shape long-polls under the previous org).
		expect(asStub(first.dashboards).cleanup).not.toHaveBeenCalled()
		// Unsubscribed siblings of the same set go down immediately.
		expect(asStub(first.alertRules).cleanup).toHaveBeenCalledTimes(1)

		// Consumers drain one by one; cleanup only fires at zero.
		asStub(first.dashboards).setSubscribers(1)
		expect(asStub(first.dashboards).cleanup).not.toHaveBeenCalled()
		asStub(first.dashboards).setSubscribers(0)
		expect(asStub(first.dashboards).cleanup).toHaveBeenCalledTimes(1)

		// The drain path cancelled the fallback timer — no double cleanup later.
		vi.advanceTimersByTime(60_000)
		expect(asStub(first.dashboards).cleanup).toHaveBeenCalledTimes(1)
	})

	it("force-cleans a leaked subscription after the fallback window", async () => {
		const { mod } = await freshModule()

		const first = mod.getOrgCollections("org_a")
		asStub(first.dashboards).setSubscribers(1)
		mod.getOrgCollections("org_b")
		expect(asStub(first.dashboards).cleanup).not.toHaveBeenCalled()

		// The subscriber never lets go — a stale shape stream must not long-poll
		// forever, so the fallback tears it down anyway.
		vi.advanceTimersByTime(30_000)
		expect(asStub(first.dashboards).cleanup).toHaveBeenCalledTimes(1)

		// A late drain doesn't clean up a second time.
		asStub(first.dashboards).setSubscribers(0)
		expect(asStub(first.dashboards).cleanup).toHaveBeenCalledTimes(1)
	})

	it("waits for drain on schema self-heal recreation too", async () => {
		const { mod } = await freshModule()

		const before = mod.getOrgCollections("org_a")
		asStub(before.dashboards).setSubscribers(1)

		mod.recreateOrgCollections()
		expect(asStub(before.dashboards).cleanup).not.toHaveBeenCalled()

		// Generation bumped → the next resolve mints a fresh set for the same org.
		const after = mod.getOrgCollections("org_a")
		expect(after).not.toBe(before)

		asStub(before.dashboards).setSubscribers(0)
		expect(asStub(before.dashboards).cleanup).toHaveBeenCalledTimes(1)
		expect(asStub(after.dashboards).cleanup).not.toHaveBeenCalled()
	})

	it("stuck-loading recreates share the schema-heal budget", async () => {
		const { mod, runFork } = await freshModule()
		const start = mod.getCollectionsGeneration()

		// Mixed triggers draw from ONE budget: two schema errors + endless stuck
		// reports still cap at MAX_SCHEMA_HEAL_ATTEMPTS total recreations.
		mod.handleSchemaError()
		vi.advanceTimersByTime(6_000)
		mod.handleCollectionStuck()
		vi.advanceTimersByTime(6_000)
		for (let i = 0; i < 10; i++) {
			mod.handleCollectionStuck()
			vi.advanceTimersByTime(6_000)
		}

		expect(mod.getCollectionsGeneration()).toBe(start + 3)
		// Each stuck recreate logs a warning (2 of the 3 recreations here), plus
		// exactly one give-up log.
		expect(runFork).toHaveBeenCalledTimes(3)
	})

	it("collapses a burst of stuck reports into a single recreation", async () => {
		const { mod } = await freshModule()
		const start = mod.getCollectionsGeneration()

		// Several stores hitting their stuck timeout at once (three collections in
		// one model) must not each schedule their own recreation.
		mod.handleCollectionStuck()
		mod.handleCollectionStuck()
		mod.handleCollectionStuck()
		vi.advanceTimersByTime(6_000)

		expect(mod.getCollectionsGeneration()).toBe(start + 1)
	})

	it("resets the heal budget on a genuine org switch", async () => {
		const { mod } = await freshModule()

		// Exhaust the budget.
		for (let i = 0; i < 12; i++) {
			mod.handleSchemaError()
			vi.advanceTimersByTime(6_000)
		}
		const exhausted = mod.getCollectionsGeneration()

		// Switching orgs (second call sees a different id) refreshes the budget.
		mod.getOrgCollections("org_a")
		mod.getOrgCollections("org_b")

		mod.handleSchemaError()
		vi.advanceTimersByTime(6_000)

		expect(mod.getCollectionsGeneration()).toBe(exhausted + 1)
	})
})
