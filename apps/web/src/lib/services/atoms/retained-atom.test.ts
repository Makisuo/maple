import { beforeEach, describe, expect, it } from "vitest"

import { Atom, Registry, Result } from "@/lib/effect-atom"

import { clearRetainedResults, nextRetentionNamespace } from "./result-retention"
import { withRetention } from "./retained-atom"

beforeEach(() => {
	clearRetainedResults()
})

/** A cold atom: what a rebuilt query atom looks like before its fetch lands. */
const pending = <A>() => Atom.make(() => Result.initial<A, never>())

/** A settled atom: what one looks like once its fetch has resolved. */
const settled = <A>(value: A) => Atom.make(() => Result.success<A, never>(value))

describe("withRetention", () => {
	it("passes a live result straight through", () => {
		const registry = Registry.make()
		const result = registry.get(withRetention(settled("fresh"), "id"))

		expect(Result.isSuccess(result) && result.value).toBe("fresh")
	})

	// The whole point: the atom that recorded the value is gone (disposed by its
	// idle TTL, or replaced because the time window rolled), and a brand-new one
	// under the same logical identity must not paint a skeleton.
	it("serves a previous result to a rebuilt atom under the same identity", () => {
		const identity = "shared-identity"

		const first = Registry.make()
		first.get(withRetention(settled("recorded"), identity))

		const rebuilt = Registry.make()
		const result = rebuilt.get(withRetention(pending<string>(), identity))

		expect(Result.isSuccess(result) && result.value).toBe("recorded")
	})

	it("marks a served fallback as waiting, so the UI can show it is refreshing", () => {
		const identity = "waiting-identity"

		Registry.make().get(withRetention(settled("recorded"), identity))
		const result = Registry.make().get(withRetention(pending<string>(), identity))

		expect(result.waiting).toBe(true)
	})

	it("stays Initial when nothing was ever recorded", () => {
		const result = Registry.make().get(withRetention(pending<string>(), "never-seen"))

		expect(Result.isInitial(result)).toBe(true)
	})

	// Regression: identities are the query minus its time window, so two queries
	// that take only a window both reduce to the same string. Namespacing is what
	// stops one serving the other's rows to a component expecting a different shape.
	it("does not serve one namespace's value to another", () => {
		const a = `${nextRetentionNamespace()}:{}`
		const b = `${nextRetentionNamespace()}:{}`

		Registry.make().get(withRetention(settled({ facets: [] }), a))
		const result = Registry.make().get(withRetention(pending<{ services: number }>(), b))

		expect(Result.isInitial(result)).toBe(true)
	})

	it("records when the value was produced, not when it was read", () => {
		const identity = "aging-identity"
		// Reading is what triggers recording, so stamping entries with the read
		// time would let a value that is repeatedly re-read never age out. The
		// Result's own timestamp is used instead, and it must survive round-trip.
		const producedAt = Date.now() - 60_000
		const registry = Registry.make()
		const atom = withRetention(
			Atom.make(() => Result.success("v", { timestamp: producedAt })),
			identity,
		)

		registry.get(atom)
		registry.get(atom)

		const served = Registry.make().get(withRetention(pending<string>(), identity))
		expect(Result.isSuccess(served) && served.timestamp).toBe(producedAt)
	})

	it("refuses to serve a value older than the age bound", () => {
		const identity = "stale-identity"
		Registry.make().get(
			withRetention(
				Atom.make(() => Result.success("ancient", { timestamp: Date.now() - 60 * 60 * 1000 })),
				identity,
			),
		)

		const served = Registry.make().get(withRetention(pending<string>(), identity))
		expect(Result.isInitial(served)).toBe(true)
	})
})
