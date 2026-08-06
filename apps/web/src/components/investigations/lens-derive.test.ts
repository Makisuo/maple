import type { V2Investigation } from "@maple/domain/http/v2"
import { describe, expect, it } from "vitest"

import { checksHeld, fanoutRunSteps, hasFanout, lensChecks, lensTally, type LensRun } from "./lens-derive"

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

describe("fanoutRunSteps", () => {
	it("drops out entirely on the single-pass path", () => {
		expect(fanoutRunSteps(make())).toEqual([])
	})

	it("reports progress while lenses are still in flight", () => {
		const steps = fanoutRunSteps(
			make({
				lens_runs: [lens(), lens({ lensId: "traffic_shape", status: "checking" })],
				validator: {
					status: "blocked",
					note: "Starts once all 2 lenses report",
					elapsedSeconds: null,
				},
				fanout: { state: "running", size: 2 },
			} as never),
		)
		expect(steps.map((step) => step.key)).toEqual(["dispatched", "reporting"])
		expect(steps[1]!.label).toBe("1 of 2 reported")
	})

	/**
	 * The wedge this file exists to prevent. A lens that crashes becomes a
	 * terminal `no_finding` lane and the workflow ranks anyway — so gating on
	 * "reported" left the spine pulsing "4 of 5 reported" on a run that had
	 * already published a diagnosis.
	 */
	it("does not stall when a lens ended with no finding", () => {
		const steps = fanoutRunSteps(
			make({
				lens_runs: [
					lens({ verdict: "promoted" }),
					lens({ lensId: "traffic_shape", status: "no_finding", verdict: "rejected" }),
				],
				validator: { status: "ranked", note: "1 promoted · 1 rejected", elapsed_seconds: 8.2 },
				fanout: { state: "ranked", size: 2 },
			} as never),
		)
		expect(steps.map((step) => step.key)).toEqual(["dispatched", "reported", "validated"])
		expect(steps.at(-1)).toMatchObject({ tone: "success" })
	})

	it("marks a run whose validator promoted nothing as inconclusive", () => {
		const steps = fanoutRunSteps(
			make({
				lens_runs: [lens({ verdict: "rejected" })],
				validator: { status: "rejected_all", note: "no candidate survived", elapsedSeconds: 8.2 },
				fanout: { state: "rejected_all", size: 1 },
			} as never),
		)
		expect(steps.at(-1)).toMatchObject({ key: "validation-inconclusive", tone: "failed" })
	})
})
