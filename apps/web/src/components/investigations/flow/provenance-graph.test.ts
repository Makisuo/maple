import type { V2Investigation } from "@maple/domain/http/v2"
import { describe, expect, it } from "vitest"

import type { LensRun } from "../lens-derive"
import { buildProvenanceGraph, selectLenses } from "./provenance-graph"

const lens = (overrides: Partial<LensRun> = {}): LensRun =>
	({
		lensId: "deploy_correlation",
		status: "reported",
		verdict: "ruled_out",
		claim: "a deploy landed before the onset",
		reason: null,
		progressNote: null,
		confidence: "medium",
		toolCount: 3,
		elapsedSeconds: 9.4,
		name: null,
		question: null,
		priority: null,
		deadlineHit: false,
		...overrides,
	}) as LensRun

const report = (overrides: Partial<NonNullable<V2Investigation["report"]>> = {}) =>
	({
		summary: "checkout-api saturated its connection pool",
		suspectedCause: "Pool exhaustion in checkout-api",
		severityAssessment: "critical",
		affectedScope: "Checkout & payment capture",
		evidence: [],
		suggestedActions: ["Roll back deploy 8f21c", "Alert on pool_active / pool_max > 0.8"],
		confidence: "high",
		...overrides,
	}) as NonNullable<V2Investigation["report"]>

const make = (overrides: Partial<V2Investigation> = {}): V2Investigation =>
	({
		id: "inv_YofPTrK9782DWwcnXhpcCw",
		status: "diagnosed",
		subject: {
			type: "incident",
			incident_kind: "error",
			incident_id: "einc_8Kd21mQr",
			issue_id: "iss_9dK1",
		},
		snapshot: {
			title: "Checkout timeouts after deploy 8f21c",
			scope: "checkout-api",
			status: "open",
			severity: "critical",
			facts: [],
			references: [],
			incidentStartedAt: "2026-08-01T14:02:00.000Z",
			incidentEndedAt: null,
			errorLabel: "CheckoutTimeoutError",
			occurrenceCount: 1284,
		},
		report: report(),
		seeded_by: "system",
		created_at: "2026-08-01T14:02:00.000Z",
		started_at: "2026-08-01T14:02:00.000Z",
		diagnosed_at: "2026-08-01T14:02:38.000Z",
		updated_at: "2026-08-01T14:02:38.000Z",
		lens_runs: [],
		validator: null,
		fanout: { state: "none", size: 0 },
		...overrides,
	}) as V2Investigation

/** Column headings are chrome, not chain — they never belong in a shape assertion. */
const chain = (investigation: V2Investigation) =>
	buildProvenanceGraph(investigation).nodes.filter((node) => node.type !== "heading")

const kinds = (investigation: V2Investigation) =>
	chain(investigation).map((node) => (node.type === "spine" ? node.data.eyebrow : node.type))

describe("buildProvenanceGraph", () => {
	it("lays the full chain out left to right", () => {
		const graph = buildProvenanceGraph(
			make({ lens_runs: [lens(), lens({ verdict: "promoted" })] } as never),
		)
		expect(kinds(make({ lens_runs: [lens()] } as never))).toEqual([
			"ISSUE",
			"INCIDENT",
			"INVESTIGATION",
			"lens",
			"VERDICT",
			"action",
			"action",
		])
		// Column origins are 198 apart (146 spine + 52 gutter) up to the lens column,
		// which is 180 wide rather than 146 — so every origin after it is offset by
		// that extra 34, and the actions column lands 34 further right. x stays
		// strictly increasing and the graph never overlaps, which is what this pins.
		const xs = [...new Set(graph.nodes.map((node) => node.position.x))].sort((a, b) => a - b)
		expect(xs).toEqual([0, 198, 396, 594, 826, 1024])
		expect(graph.width).toBe(1304)
	})

	/**
	 * The columns are assembled before they are positioned, so a chain that has no
	 * issue and no incident starts at x=0 rather than leaving two empty columns of
	 * dead canvas on the left.
	 */
	it("collapses the columns a freeform investigation has no row for", () => {
		const graph = buildProvenanceGraph(
			make({
				subject: { type: "freeform", title: "why is checkout slow", prompt: "…", context_refs: [] },
			} as never),
		)
		expect(graph.nodes.filter((node) => node.type !== "heading")[0]).toMatchObject({
			position: { x: 0 },
			data: { eyebrow: "INVESTIGATION" },
		})
	})

	/** Spec rule 03: alert-sourced runs swap ISSUE for CHECK. */
	it("shows a check, not an issue, for an alert-sourced run", () => {
		expect(
			kinds(
				make({
					subject: {
						type: "incident",
						incident_kind: "alert",
						incident_id: "inc_8Kd21mQr",
						issue_id: null,
					},
				} as never),
			),
		).toContain("CHECK")
	})

	it("renders no origin node when an incident has no issue behind it", () => {
		expect(
			kinds(
				make({
					subject: {
						type: "incident",
						incident_kind: "error",
						incident_id: "einc_8Kd21mQr",
						issue_id: null,
					},
				} as never),
			),
		).toEqual(["INCIDENT", "INVESTIGATION", "VERDICT", "action", "action"])
	})

	/** Spec rule 04: while investigating there is no verdict node — absent, not empty. */
	it("omits the verdict and the real actions while the pass is still running", () => {
		const running = kinds(
			make({
				status: "investigating",
				report: null,
				lens_runs: [lens({ status: "checking" })],
			} as never),
		)
		expect(running).not.toContain("VERDICT")
		expect(running).not.toContain("action")
	})

	/**
	 * Same argument as the pending-verdict ghost, one column further right: the
	 * chain used to stop dead at the fan's merge, which reads as finished. Two
	 * wordless cards say the column is still coming without claiming what will be
	 * in it — the heading carries no count for the same reason.
	 */
	it("stands wordless ghosts where the proposed actions will land", () => {
		const graph = buildProvenanceGraph(
			make({
				status: "investigating",
				report: null,
				lens_runs: [lens({ status: "checking" })],
				fanout: { state: "running", size: 1 },
			} as never),
		)
		const ghosts = graph.nodes.filter((node) => node.type === "actionGhost")
		expect(ghosts.map((node) => node.id)).toEqual(["action-ghost-0", "action-ghost-1"])
		// No text on the wire at all — the only field is a layout slot.
		expect(ghosts.map((node) => node.data)).toEqual([{ slot: 0 }, { slot: 1 }])
		expect(graph.actionHeading).toBe("PROPOSES · PENDING")
		// They feed off the pending verdict, and their strands march like it does.
		const roadmap = graph.edges.filter((edge) => edge.kind === "roadmap")
		expect(roadmap.map((edge) => edge.source)).toEqual(["pending-verdict", "pending-verdict"])
		expect(roadmap.every((edge) => edge.live)).toBe(true)
	})

	it("raises no action ghosts once the report has landed, or where there was no fan", () => {
		const ghosts = (investigation: V2Investigation) =>
			buildProvenanceGraph(investigation).nodes.filter((node) => node.type === "actionGhost")
		// Diagnosed: the real action nodes are there instead.
		expect(ghosts(make())).toHaveLength(0)
		expect(ghosts(make({ status: "failed", report: null } as never))).toHaveLength(0)
		// No fan means no pending verdict to hang them off.
		expect(ghosts(make({ status: "investigating", report: null } as never))).toHaveLength(0)
	})

	/**
	 * What stands where the verdict will go. It states the process and never a
	 * finding, which is what keeps it from being the placeholder verdict the rule
	 * above forbids — and without it the chain stops mid-air at the fan.
	 */
	it("stands a process-only ghost where the verdict will land", () => {
		const graph = buildProvenanceGraph(
			make({
				status: "investigating",
				report: null,
				lens_runs: [lens({ status: "reported", verdict: "pending" }), lens({ status: "checking" })],
				fanout: { state: "running", size: 2 },
			} as never),
		)
		const ghost = graph.nodes.find((node) => node.type === "pendingVerdict")
		expect(ghost).toMatchObject({ data: { word: "AWAITING VERDICT", note: "1 of 2 lenses reported" } })
		// No claim anywhere on it — no cause, no confidence, no instant.
		expect(Object.keys(ghost?.data ?? {})).toEqual(["word", "note"])
	})

	it("says VALIDATING once every lane has settled", () => {
		const graph = buildProvenanceGraph(
			make({
				status: "investigating",
				report: null,
				lens_runs: [lens({ status: "reported", verdict: "pending" }), lens({ status: "no_finding" })],
				fanout: { state: "validating", size: 2 },
			} as never),
		)
		expect(graph.nodes.find((node) => node.type === "pendingVerdict")).toMatchObject({
			data: { word: "VALIDATING" },
		})
	})

	it("raises no ghost once the run has ended, or where there was no fan", () => {
		const ghosts = (investigation: V2Investigation) =>
			buildProvenanceGraph(investigation).nodes.filter((node) => node.type === "pendingVerdict")
		expect(ghosts(make())).toHaveLength(0)
		expect(ghosts(make({ status: "failed", report: null } as never))).toHaveLength(0)
		// A single-pass run dispatched no lenses; a ghost merging a fan of none is a
		// column about work that was never split up.
		expect(ghosts(make({ status: "investigating", report: null } as never))).toHaveLength(0)
	})

	/**
	 * The inversion this whole pass exists for: motion means live. A finished
	 * investigation's strands must be inert, or the one moving signal on the canvas
	 * is spent on a diagnosis from last week.
	 */
	it("marks live only the strands feeding work that is still open", () => {
		expect(buildProvenanceGraph(make({ lens_runs: [lens()] } as never)).edges.some((e) => e.live)).toBe(
			false,
		)

		const graph = buildProvenanceGraph(
			make({
				status: "investigating",
				report: null,
				lens_runs: [
					lens({ lensId: "settled", status: "reported", verdict: "pending" }),
					lens({ lensId: "busy", status: "checking" }),
					lens({ lensId: "waiting", status: "queued" }),
				],
				fanout: { state: "running", size: 3 },
			} as never),
		)
		const live = graph.edges.filter((edge) => edge.live).map((edge) => edge.target)
		expect(live).toContain("investigation")
		expect(live).toContain("pending-verdict")
		expect(live.some((id) => id.startsWith("lens-busy"))).toBe(true)
		// Queued is live too — nothing has happened on that lane yet.
		expect(live.some((id) => id.startsWith("lens-waiting"))).toBe(true)
		expect(live.some((id) => id.startsWith("lens-settled"))).toBe(false)
	})

	it("names the stage a running pass is in", () => {
		const phase = (overrides: Partial<V2Investigation>) => {
			const nodes = chain(make({ status: "investigating", report: null, ...overrides } as never))
			const node = nodes.find((n) => n.id === "investigation")
			return node?.type === "spine" ? node.data.phase : undefined
		}
		expect(phase({ fanout: { state: "queued", size: 3 } } as never)).toBe("QUEUEING")
		expect(
			phase({
				fanout: { state: "running", size: 2 },
				lens_runs: [lens({ status: "reported" }), lens({ status: "checking" })],
			} as never),
		).toBe("FANNING OUT · 1/2")
		expect(phase({ fanout: { state: "validating", size: 2 } } as never)).toBe("VALIDATING")
		// The single-pass path, and the one that must not be labelled VALIDATING:
		// `blocked` is set for the whole time the lanes are still reporting.
		expect(phase({} as never)).toBe("RUNNING")
		expect(
			phase({
				fanout: { state: "running", size: 1 },
				lens_runs: [lens({ status: "checking" })],
				validator: { status: "blocked", note: "waiting", elapsedSeconds: null },
			} as never),
		).toBe("FANNING OUT · 0/1")
		// A finished run states its outcome, not a stage.
		const done = chain(make()).find((node) => node.id === "investigation")
		expect(done?.type === "spine" ? done.data.phase : "set").toBeUndefined()
	})

	it("hands the caption a clock to tick against only while the pass runs", () => {
		expect(buildProvenanceGraph(make()).runningSince).toBeNull()
		expect(
			buildProvenanceGraph(make({ status: "investigating", report: null } as never)).runningSince,
		).toBe(Date.parse("2026-08-01T14:02:00.000Z"))
	})

	it("omits the verdict on a failed pass that attached no report", () => {
		expect(kinds(make({ status: "failed", report: null } as never))).not.toContain("VERDICT")
	})

	it("renders no actions column when the report proposed nothing", () => {
		expect(kinds(make({ report: report({ suggestedActions: [] }) } as never))).not.toContain("action")
	})

	/** Spec rule 01: exactly one amber node — a second means "you are here" has stopped meaning anything. */
	it("marks exactly one node as current", () => {
		const graph = buildProvenanceGraph(make({ lens_runs: [lens(), lens()] } as never))
		const current = graph.nodes.filter((node) => node.type === "spine" && node.data.current)
		expect(current).toHaveLength(1)
	})

	it("names the origin after the exception rather than the opaque issue id", () => {
		expect(chain(make())[0]).toMatchObject({ data: { title: "CheckoutTimeoutError" } })
	})

	/**
	 * The regression this guards: `incident_id` and `id` are `inc_…`/`inv_…` public
	 * ids on the wire, but the schema decodes them back to the underlying UUIDs —
	 * so printing them put `88888888-8888-4888-8888-…` across two wrapped lines on a
	 * 146px node. Identifiers belong in the tooltip; the node says what happened.
	 */
	it("never prints a raw identifier on a node", () => {
		const uuidish = /[0-9a-f]{8}-[0-9a-f]{4}/i
		for (const node of chain(make({ lens_runs: [lens()] } as never))) {
			if (node.type !== "spine") continue
			expect(node.data.title).not.toMatch(uuidish)
		}
	})

	it("titles the incident with the signal that fired", () => {
		const graph = buildProvenanceGraph(
			make({
				snapshot: {
					...make().snapshot,
					facts: [{ label: "Signal", value: "http_5xx" }],
				},
			} as never),
		)
		const incident = graph.nodes.find((node) => node.id === "incident")
		expect(incident).toMatchObject({ data: { title: "http_5xx" } })
		// The id is still reachable, just not printed.
		expect(incident).toMatchObject({ data: { titleHint: "einc_8Kd21mQr" } })
	})

	it("falls back to the scope when the incident recorded no signal", () => {
		expect(buildProvenanceGraph(make()).nodes.find((node) => node.id === "incident")).toMatchObject({
			data: { title: "checkout-api" },
		})
	})

	it("stamps each step with its own instant", () => {
		const stamped = Object.fromEntries(
			chain(make()).map((node) => [node.id, node.type === "spine" ? node.data.at : undefined]),
		)
		expect(stamped).toMatchObject({
			incident: "2026-08-01T14:02:00.000Z",
			investigation: "2026-08-01T14:02:00.000Z",
			verdict: "2026-08-01T14:02:38.000Z",
		})
	})

	/**
	 * The issue has no instant anywhere on the v2 wire. Borrowing the incident's
	 * would put the same "6h ago" on two adjacent cards and imply a gap that was
	 * never measured — so the card carries no footer at all.
	 */
	it("leaves a step unstamped rather than borrowing a neighbour's instant", () => {
		const origin = chain(make())[0]
		expect(origin).toMatchObject({ data: { eyebrow: "ISSUE" } })
		expect(origin?.type === "spine" ? origin.data.at : "set").toBeUndefined()
	})

	it("does not stamp a verdict the run never reached", () => {
		const nodes = chain(make({ status: "investigating", report: null } as never))
		expect(nodes.find((node) => node.id === "verdict")).toBeUndefined()
		expect(nodes.find((node) => node.id === "investigation")).toMatchObject({
			data: { at: "2026-08-01T14:02:00.000Z" },
		})
	})

	/**
	 * The held count was the deleted checks rail's header — the fastest read of
	 * whether the verdict deserves trust — so it moved onto the column heading
	 * rather than being lost with the rail.
	 */
	it("counts the lenses that held once the validator has ranked", () => {
		const ranked = make({
			lens_runs: [lens({ verdict: "promoted" }), lens({ verdict: "ruled_out" })],
			validator: { status: "ranked", note: "1 promoted", elapsedSeconds: 8.2 },
		} as never)
		expect(buildProvenanceGraph(ranked).lensHeading).toBe("FANNED OUT · 2 LENSES · 1 HELD")
	})

	it("withholds the held count while the lenses are still running", () => {
		const running = make({
			status: "investigating",
			report: null,
			lens_runs: [lens({ status: "checking" }), lens({ status: "queued" })],
			validator: { status: "blocked", note: "waiting", elapsedSeconds: null },
		} as never)
		// "0 held" over two lanes nobody has ranked states a result the run never reached.
		expect(buildProvenanceGraph(running).lensHeading).toBe("FANNED OUT · 2 LENSES")
	})

	it("carries the validator's own sentence on the lens it belongs to", () => {
		const graph = buildProvenanceGraph(
			make({
				lens_runs: [lens({ reason: "callee percentiles stayed flat across the window" })],
			} as never),
		)
		expect(graph.nodes.find((node) => node.type === "lens")).toMatchObject({
			data: { result: "callee percentiles stayed flat across the window" },
		})
	})

	it("titles the investigation node with how the run went", () => {
		expect(chain(make()).find((node) => node.id === "investigation")).toMatchObject({
			data: { title: "Diagnosed" },
		})
		expect(
			chain(make({ status: "failed", report: null } as never)).find(
				(node) => node.id === "investigation",
			),
		).toMatchObject({ data: { title: "Failed" } })
	})

	it("captions the canvas with the run's own window", () => {
		expect(buildProvenanceGraph(make()).caption).toMatch(/→.*· 38s$/)
	})
})

describe("selectLenses", () => {
	/** Spec rule 02: above five, the fan draws four strands plus a "+N more" — never N. */
	it("collapses above five lenses to the top four by priority", () => {
		const runs = [1, 2, 3, 4, 5, 6, 7].map((priority) =>
			lens({ lensId: `lens_${priority}`, priority: 8 - priority }),
		)
		const { visible, hidden } = selectLenses(runs)
		expect(hidden).toBe(3)
		// Ranked by priority, then restored to dispatch order so the fan reads
		// top-to-bottom as it actually ran.
		expect(visible.map((run) => run.lensId)).toEqual(["lens_4", "lens_5", "lens_6", "lens_7"])
	})

	it("shows all five rather than four and a +1", () => {
		const runs = [1, 2, 3, 4, 5].map((n) => lens({ lensId: `lens_${n}` }))
		expect(selectLenses(runs)).toMatchObject({ hidden: 0 })
		expect(selectLenses(runs).visible).toHaveLength(5)
	})

	/** Lanes written before the planner carry no priority — they sort last but keep their order. */
	it("sinks unprioritised lanes without reshuffling them", () => {
		const runs = [
			lens({ lensId: "a" }),
			lens({ lensId: "b", priority: 1 }),
			lens({ lensId: "c" }),
			lens({ lensId: "d", priority: 2 }),
			lens({ lensId: "e" }),
			lens({ lensId: "f" }),
		]
		expect(selectLenses(runs).visible.map((run) => run.lensId)).toEqual(["a", "b", "c", "d"])
	})
})
