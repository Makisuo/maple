import type { V2Investigation } from "@maple/domain/http/v2"
import { describe, expect, it } from "vitest"

import { checksHeld, hasFanout, lensChecks, lensNodeState, lensTally, type LensRun } from "./lens-derive"

const lens = (overrides: Partial<LensRun> = {}): LensRun =>
	({
		lensId: "deploy_correlation",
		status: "reported",
		verdict: "ruled_out",
		claim: "a deploy landed before the onset",
		reason: "no deploy landed inside the window",
		progressNote: null,
		confidence: "medium",
		toolCount: 3,
		elapsedSeconds: 12.6,
		name: null,
		question: null,
		priority: null,
		deadlineHit: false,
		...overrides,
	}) as LensRun

const make = (overrides: Partial<V2Investigation> = {}): V2Investigation =>
	({
		id: "inv_1",
		status: "diagnosed",
		lens_runs: [],
		validator: null,
		fanout: { state: "none", size: 1 },
		...overrides,
	}) as V2Investigation

describe("hasFanout", () => {
	/**
	 * The collision the split exists for: the sizing table says 5 because it is an
	 * alert, the routing gate declined because it arrived automatically at medium
	 * severity. Reading `fanout.size` here would render a Hypotheses tab over an
	 * empty array.
	 */
	it("keys off dispatched lenses, not the computed size", () => {
		expect(hasFanout(make({ lens_runs: [], fanout: { state: "none", size: 5 } } as never))).toBe(false)
		expect(hasFanout(make({ lens_runs: [lens()] } as never))).toBe(true)
	})
})

describe("lensChecks", () => {
	it("runs one check per dispatched lens, in the order given", () => {
		const lenses = [lens({ lensId: "deploy_correlation" }), lens({ lensId: "traffic_shape" })]
		expect(lensChecks(lenses).map((check) => check.key)).toEqual(["deploy_correlation", "traffic_shape"])
	})

	it("holds exactly the lenses the validator kept", () => {
		const lenses = [
			lens({ verdict: "promoted" }),
			lens({ lensId: "traffic_shape", verdict: "merged" }),
			lens({ lensId: "config_flags", verdict: "ruled_out" }),
		]
		expect(checksHeld(lensChecks(lenses))).toBe(2)
	})

	/**
	 * The regression the placeholder module shipped with: the rail generated its
	 * own verdicts, so a run whose validator rejected everything still showed
	 * green ticks a few hundred pixels from "none of them held up".
	 */
	it("holds nothing when the validator promoted nothing", () => {
		const lenses = [lens({ verdict: "rejected" }), lens({ lensId: "traffic_shape", verdict: "rejected" })]
		expect(checksHeld(lensChecks(lenses))).toBe(0)
	})

	/**
	 * While the validator is reading the candidates every lane is `pending`.
	 * Rendering those as "failed" put an ✗ and a "0 of 5 held" header beside a
	 * card saying the validator was still blocked.
	 */
	it("does not rule against a lens the validator has not ranked yet", () => {
		const checks = lensChecks([
			lens({ verdict: "pending" }),
			lens({ lensId: "traffic_shape", verdict: "pending" }),
		])
		expect(checks.map((check) => check.state)).toEqual(["pending", "pending"])
		expect(checksHeld(checks)).toBe(0)
		// It shows what the lens said, not a verdict nobody reached.
		expect(checks[0]!.result).toBe("a deploy landed before the onset")
	})

	it("quotes the validator's own sentence rather than a canned one", () => {
		const checks = lensChecks([lens({ reason: "callee percentiles stayed flat across the window" })])
		expect(checks[0]!.result).toBe("callee percentiles stayed flat across the window")
	})

	it("maps in-flight lanes to their live states", () => {
		const checks = lensChecks([
			lens({ status: "checking", progressNote: "comparing percentiles…" }),
			lens({ lensId: "traffic_shape", status: "queued" }),
			lens({ lensId: "config_flags", status: "no_finding", reason: "ran out of budget" }),
		])
		expect(checks.map((check) => check.state)).toEqual(["checking", "queued", "skipped"])
		expect(checks[0]!.result).toBe("comparing percentiles…")
	})

	it("never renders an empty result line", () => {
		for (const status of ["queued", "checking", "reported", "no_finding"] as const) {
			for (const check of lensChecks([
				lens({ status, reason: null, claim: null, progressNote: null }),
			])) {
				expect(check.result.length).toBeGreaterThan(0)
			}
		}
	})
})

/**
 * `lens_runs` is documented as an evolving shape. That promise was empty while
 * the tokens were closed literals: a server that learned a sixth lens failed the
 * decode for every deployed client and blanked the page. These assert the client
 * survives one.
 */
describe("unknown catalogue tokens", () => {
	it("renders a lens it has never heard of", () => {
		const checks = lensChecks([lens({ lensId: "cache_pressure" } as never)])
		expect(checks[0]!.label).toBe("Cache pressure")
		expect(checks[0]!.result).toBeTruthy()
	})

	it("does not claim an unknown verdict held", () => {
		const checks = lensChecks([lens({ verdict: "deferred" } as never)])
		expect(checksHeld(checks)).toBe(0)
	})
})

describe("lensTally", () => {
	it("splits the verdicts", () => {
		const tally = lensTally([
			lens({ verdict: "promoted" }),
			lens({ verdict: "merged" }),
			lens({ verdict: "ruled_out" }),
			lens({ verdict: "rejected", status: "no_finding" }),
		])
		expect(tally).toEqual({
			total: 4,
			reported: 3,
			// The `no_finding` lane never reported a candidate, but it is terminal —
			// it is what a crashed lens becomes, and the run proceeds past it.
			settled: 4,
			promoted: 1,
			merged: 1,
			ruledOut: 1,
			rejected: 1,
		})
	})
})

describe("lensNodeState", () => {
	it("always states the verdict in words, never in colour alone", () => {
		const runs = [
			lens({ status: "queued" }),
			lens({ status: "checking" }),
			lens({ verdict: "promoted" }),
			lens({ verdict: "merged" }),
			lens({ verdict: "ruled_out" }),
			lens({ verdict: "pending" }),
			lens({ deadlineHit: true }),
			lens({ status: "no_finding" }),
		]
		for (const state of runs.map(lensNodeState)) {
			expect(state.word.length).toBeGreaterThan(0)
		}
	})

	/**
	 * A lane that ran out of clock says so before it says anything about a
	 * verdict — the workflow writes `ruled_out` on lanes it never heard back from,
	 * and rendering that is a claim the run did not make.
	 */
	it("reports a timed-out lane as timed out, not as ruled out", () => {
		expect(lensNodeState(lens({ deadlineHit: true, verdict: "ruled_out" }))).toMatchObject({
			word: "DEADLINE HIT",
			tone: "warning",
		})
	})

	it("agrees with the checks rail about which lanes held", () => {
		const runs = [
			lens({ verdict: "promoted" }),
			lens({ verdict: "merged" }),
			lens({ verdict: "rejected" }),
		]
		const heldWords = runs.map((run) => lensNodeState(run).word).filter((word) => word !== "RULED OUT")
		expect(heldWords).toHaveLength(checksHeld(lensChecks(runs)))
	})

	it("does not strike a lane the validator has not ranked yet", () => {
		expect(lensNodeState(lens({ verdict: "pending" }))).toMatchObject({
			word: "REPORTED",
			struck: false,
		})
	})
})
