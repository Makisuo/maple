/**
 * Every state the provenance canvas can draw, on one canvas.
 *
 * The page only ever shows the handful of states a real investigation happens to
 * be in, so most of this surface — eight lens states, ten action glyphs, three
 * edge kinds doubled by `live` — has never been seen side by side. That is the
 * one view in which "does this read as one system?" is answerable at all, and
 * this builder is it.
 *
 * It emits the *same* `ProvenanceNode` / `ProvenanceEdge` shapes
 * `buildProvenanceGraph` does, so the studio can hand them to the production node
 * components untouched. What it does not do is share the layout: the real graph
 * is a causal chain in columns, this is a labelled grid, and forcing one to
 * produce the other would mean bending the chain's arithmetic around a catalogue.
 *
 * Free of React and of `@xyflow/react`, for the same reason `provenance-graph.ts`
 * is: coverage over the state space is a fact about this array, and it should be
 * assertable without mounting a canvas.
 */
import { lensChecks, lensNodeState, type LensRun } from "../lens-derive"
import { lensCopy } from "../lens-catalogue"
import { ACTION_GLYPH } from "./flow-nodes"
import type { ActionKind, ActionTarget } from "./action-target"
import {
	ACTION_HEIGHT,
	ACTION_WIDTH,
	HEADING_HEIGHT,
	LENS_HEIGHT,
	LENS_WIDTH,
	SPINE_HEIGHT,
	SPINE_HEIGHT_CURRENT,
	SPINE_HEIGHT_LIVE,
	SPINE_HEIGHT_TALL,
	SPINE_WIDTH,
	type FlowGlyph,
	type FlowTone,
	type ProvenanceEdge,
	type ProvenanceNode,
	type SpineNodeData,
	type XY,
} from "./provenance-graph"

/* -------------------------------------------------------------------------------------------------
 * Grid
 * -----------------------------------------------------------------------------------------------*/

/**
 * Cells wrap past this.
 *
 * Sized to the content column of a laptop window with the sidebar open, not to
 * the widest row the cells could form: the canvas pans but the page does not
 * scroll sideways, so anything past the pane's right edge is a cell nobody knows
 * is there. Wrapping more often is the cheaper mistake.
 */
const ROW_MAX = 940
const CELL_GAP_X = 28
const CELL_GAP_Y = 34
/** Each cell's caption rides above it, the same 20px the real column headings use. */
const LABEL_OFFSET = 18
const SECTION_GAP = 56
/** Section titles get the full row to themselves. */
const SECTION_TITLE_WIDTH = ROW_MAX
/** The gap an edge cell leaves between its two anchors, wide enough to read the strand and its label. */
const EDGE_SPAN = 96

export interface NodeCatalogue {
	readonly nodes: ReadonlyArray<ProvenanceNode>
	readonly edges: ReadonlyArray<ProvenanceEdge>
	readonly width: number
	readonly height: number
}

/**
 * The cursor the section helpers below write through.
 *
 * A closure rather than an exported class: everything about this layout is
 * private to one function call, and the only thing worth handing out is the
 * finished arrays.
 */
function grid() {
	const nodes: Array<ProvenanceNode> = []
	const edges: Array<ProvenanceEdge> = []
	let x = 0
	let y = 0
	let rowHeight = 0
	let seq = 0

	const nextId = (prefix: string) => `${prefix}-${seq++}`

	const label = (text: string, at: XY, width: number) => {
		nodes.push({
			id: nextId("label"),
			type: "heading",
			position: { x: at.x, y: at.y - LABEL_OFFSET },
			width,
			height: HEADING_HEIGHT,
			data: { text },
		})
	}

	/** Claim a cell of this size, wrapping the row if it no longer fits, and caption it. */
	const reserve = (caption: string, width: number, height: number): XY => {
		if (x > 0 && x + width > ROW_MAX) {
			y += rowHeight + CELL_GAP_Y + LABEL_OFFSET
			x = 0
			rowHeight = 0
		}
		const at = { x, y }
		label(caption, at, width)
		x += width + CELL_GAP_X
		rowHeight = Math.max(rowHeight, height)
		return at
	}

	const section = (title: string) => {
		if (nodes.length > 0) y += rowHeight + SECTION_GAP
		x = 0
		rowHeight = 0
		nodes.push({
			id: nextId("section"),
			type: "heading",
			position: { x: 0, y },
			width: SECTION_TITLE_WIDTH,
			height: HEADING_HEIGHT,
			data: { text: title },
		})
		y += HEADING_HEIGHT + LABEL_OFFSET + LABEL_OFFSET
	}

	return { nodes, edges, nextId, reserve, section, bounds: () => ({ x, y, rowHeight }) }
}

type Grid = ReturnType<typeof grid>

/* -------------------------------------------------------------------------------------------------
 * Cells
 * -----------------------------------------------------------------------------------------------*/

/**
 * The same height rule the real builder applies, so a cell that clips here clips
 * on the page — the whole point of previewing in the production renderer.
 */
const spineHeight = (data: SpineNodeData): number => {
	if (data.live) return SPINE_HEIGHT_LIVE
	if (data.current) return SPINE_HEIGHT_CURRENT
	return data.note || data.status ? SPINE_HEIGHT_TALL : SPINE_HEIGHT
}

const spineCell = (g: Grid, caption: string, data: SpineNodeData) => {
	const height = spineHeight(data)
	const position = g.reserve(caption, SPINE_WIDTH, height)
	g.nodes.push({ id: g.nextId("spine"), type: "spine", position, width: SPINE_WIDTH, height, data })
}

/**
 * A lens cell, built from a real `LensRun` rather than a hand-written
 * `LensNodeState`.
 *
 * This is the whole reason the studio is trustworthy: the badge, tone, glyph,
 * strike and dash all come out of `lensNodeState`, and the result line out of
 * `lensChecks`, so a change to that state machine shows up here rather than
 * quietly diverging from a frozen copy of its output.
 */
const lensCell = (g: Grid, caption: string, run: LensRun) => {
	const position = g.reserve(caption, LENS_WIDTH, LENS_HEIGHT)
	g.nodes.push({
		id: g.nextId("lens"),
		type: "lens",
		position,
		width: LENS_WIDTH,
		height: LENS_HEIGHT,
		data: {
			title: lensCopy(run).name,
			question: run.question ?? "",
			result: lensChecks([run])[0]?.result ?? "",
			state: lensNodeState(run),
			elapsed: run.elapsedSeconds == null ? null : `${run.elapsedSeconds.toFixed(1)}s`,
			progressNote: run.progressNote,
		},
	})
}

const overflowCell = (g: Grid, caption: string, hidden: number) => {
	const position = g.reserve(caption, LENS_WIDTH, LENS_HEIGHT)
	g.nodes.push({
		id: g.nextId("overflow"),
		type: "lensOverflow",
		position,
		width: LENS_WIDTH,
		height: LENS_HEIGHT,
		data: { hidden },
	})
}

const pendingVerdictCell = (g: Grid, caption: string, word: string, note: string | null) => {
	const position = g.reserve(caption, SPINE_WIDTH, SPINE_HEIGHT_TALL)
	g.nodes.push({
		id: g.nextId("pending"),
		type: "pendingVerdict",
		position,
		width: SPINE_WIDTH,
		height: SPINE_HEIGHT_TALL,
		data: { word, note },
	})
}

const actionCell = (
	g: Grid,
	caption: string,
	data: {
		text: string
		kind: ActionKind
		target?: ActionTarget | null
		promise?: "AUTOFIX · SOON" | "PULL REQ · SOON"
		ordinal?: string
	},
) => {
	const position = g.reserve(caption, ACTION_WIDTH, ACTION_HEIGHT)
	g.nodes.push({
		id: g.nextId("action"),
		type: "action",
		position,
		width: ACTION_WIDTH,
		height: ACTION_HEIGHT,
		data: {
			index: 0,
			ordinal: data.ordinal ?? "01",
			text: data.text,
			kind: data.kind,
			target: data.target ?? null,
			promise: data.promise ?? "AUTOFIX · SOON",
		},
	})
}

const ghostCell = (g: Grid, caption: string, slot: number) => {
	const position = g.reserve(caption, ACTION_WIDTH, ACTION_HEIGHT)
	g.nodes.push({
		id: g.nextId("ghost"),
		type: "actionGhost",
		position,
		width: ACTION_WIDTH,
		height: ACTION_HEIGHT,
		data: { slot },
	})
}

/**
 * Two anchors with one strand between them.
 *
 * Real spine nodes rather than bare points, because that is what an edge on this
 * canvas actually connects — and only nodes that render `<Ports />` have handles
 * for a strand to land on. The anchors are deliberately plain so the eye goes to
 * the line.
 */
const edgeCell = (
	g: Grid,
	caption: string,
	edge: { kind: ProvenanceEdge["kind"]; label?: string; live?: boolean },
) => {
	const width = SPINE_WIDTH * 2 + EDGE_SPAN
	const position = g.reserve(caption, width, SPINE_HEIGHT)
	const anchor = (at: XY, text: string): string => {
		const id = g.nextId("anchor")
		g.nodes.push({
			id,
			type: "spine",
			position: at,
			width: SPINE_WIDTH,
			height: SPINE_HEIGHT,
			data: { glyph: "check", eyebrow: "ANCHOR", title: text },
		})
		return id
	}
	const source = anchor(position, "from")
	const target = anchor({ x: position.x + SPINE_WIDTH + EDGE_SPAN, y: position.y }, "to")
	g.edges.push({
		id: g.nextId("edge"),
		source,
		target,
		kind: edge.kind,
		...(edge.label ? { label: edge.label } : {}),
		...(edge.live ? { live: true } : {}),
	})
}

/* -------------------------------------------------------------------------------------------------
 * Fixtures
 * -----------------------------------------------------------------------------------------------*/

const run = (overrides: Partial<LensRun>): LensRun =>
	({
		lensId: "deploy_correlation",
		status: "reported",
		verdict: "ruled_out",
		claim: "a deploy landed 40s before the onset",
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

const TONES: ReadonlyArray<FlowTone> = ["muted", "primary", "success", "info", "warning", "destructive"]
const GLYPHS: ReadonlyArray<FlowGlyph> = ["issue", "check", "incident", "investigation", "verdict"]

/** Long enough to hit the two-line clamp and then overflow it. */
const LONG_TITLE = "CheckoutConnectionPoolExhaustedTimeoutError in payments-gateway::acquire"
const LONG_ACTION =
	"Roll back deploy 8f21c on checkout-api and payments-gateway, then hold the connection pool at its previous ceiling until the p99 acquire time settles under 40ms for a full hour"

const AT = "2026-08-01T14:02:00.000Z"

/* -------------------------------------------------------------------------------------------------
 * The catalogue
 * -----------------------------------------------------------------------------------------------*/

export function buildNodeCatalogue(): NodeCatalogue {
	const g = grid()

	/* --- spine: one cell per glyph ------------------------------------------- */

	g.section("SPINE · GLYPH")
	for (const glyph of GLYPHS) {
		spineCell(g, glyph.toUpperCase(), {
			glyph,
			eyebrow: glyph.toUpperCase(),
			title: "checkout-api",
			at: AT,
		})
	}

	/* --- spine: emphasis ------------------------------------------------------ */

	g.section("SPINE · EMPHASIS")
	spineCell(g, "PLAIN", { glyph: "incident", eyebrow: "INCIDENT", title: "checkout-api", at: AT })
	spineCell(g, "CURRENT", {
		glyph: "investigation",
		eyebrow: "INVESTIGATION",
		title: "Checkout timeouts",
		note: "38s · 4 lenses",
		current: true,
		at: AT,
	})
	spineCell(g, "LIFTED (VERDICT)", {
		glyph: "verdict",
		eyebrow: "VERDICT",
		title: "Pool exhaustion",
		lifted: true,
		at: AT,
	})
	spineCell(g, "LIVE", {
		glyph: "investigation",
		eyebrow: "INVESTIGATION",
		title: "Checkout timeouts",
		phase: "FANNING OUT · 2/4 REPORTED",
		live: true,
		at: AT,
	})
	spineCell(g, "CURRENT + LIVE", {
		glyph: "investigation",
		eyebrow: "INVESTIGATION",
		title: "Checkout timeouts",
		note: "running",
		phase: "VALIDATING · 4 CANDIDATES",
		current: true,
		live: true,
		at: AT,
	})

	/* --- spine: content rows -------------------------------------------------- */

	g.section("SPINE · CONTENT")
	spineCell(g, "TITLE ONLY", { glyph: "issue", eyebrow: "ISSUE", title: "checkout-api" })
	spineCell(g, "STATUS + DETAIL", {
		glyph: "issue",
		eyebrow: "ISSUE",
		title: "CheckoutTimeoutError",
		status: "OPEN",
		detail: "1,284 events",
		at: AT,
	})
	spineCell(g, "NOTE", {
		glyph: "check",
		eyebrow: "CHECK",
		title: "p99 latency",
		note: "breached for 6m",
		at: AT,
	})
	spineCell(g, "LINKED (href)", {
		glyph: "incident",
		eyebrow: "INCIDENT",
		title: "einc_8Kd21mQr",
		titleHint: "Open the incident",
		href: "/alerts",
		at: AT,
	})
	spineCell(g, "NO TIMESTAMP", {
		glyph: "verdict",
		eyebrow: "VERDICT",
		title: "Pool exhaustion",
		lifted: true,
	})
	spineCell(g, "OVERFLOW", {
		glyph: "issue",
		eyebrow: "AN EYEBROW LONG ENOUGH TO TRUNCATE",
		title: LONG_TITLE,
		status: "INVESTIGATING",
		detail: "a detail line long enough to truncate against the status word",
		at: AT,
	})

	/* --- spine: status tones -------------------------------------------------- */

	g.section("SPINE · STATUS TONE")
	for (const tone of TONES) {
		spineCell(g, tone.toUpperCase(), {
			glyph: "check",
			eyebrow: "CHECK",
			title: "pool_active / pool_max",
			status: tone.toUpperCase(),
			statusTone: tone,
			detail: "0.94",
			at: AT,
		})
	}

	/* --- lens ----------------------------------------------------------------- */

	g.section("LENS · STATE")
	lensCell(g, "PENDING", run({ status: "queued", verdict: "pending", elapsedSeconds: null }))
	lensCell(
		g,
		"PENDING · NO ELAPSED",
		run({ status: "queued", verdict: "pending", elapsedSeconds: null, name: "Traffic shape" }),
	)
	lensCell(
		g,
		"RUNNING · WITH NOTE",
		run({
			status: "checking",
			verdict: "pending",
			progressNote: "reading 4 traces",
			elapsedSeconds: 3.2,
		}),
	)
	lensCell(g, "RUNNING · NO NOTE", run({ status: "checking", verdict: "pending", elapsedSeconds: 1.1 }))
	lensCell(g, "DEADLINE HIT", run({ status: "reported", verdict: "pending", deadlineHit: true }))
	lensCell(
		g,
		"NO FINDING",
		run({ status: "no_finding", verdict: "pending", reason: "no deploy in the window" }),
	)
	lensCell(g, "REPORTED", run({ status: "reported", verdict: "pending" }))
	lensCell(g, "CONFIRMED", run({ status: "reported", verdict: "promoted", confidence: "high" }))
	lensCell(g, "MERGED", run({ status: "reported", verdict: "merged" }))
	lensCell(g, "RULED OUT", run({ status: "reported", verdict: "ruled_out" }))
	lensCell(g, "REJECTED", run({ status: "reported", verdict: "rejected" }))
	lensCell(
		g,
		"UNKNOWN LENS ID",
		run({ lensId: "pool_exhaustion_payments_api", status: "reported", verdict: "promoted" }),
	)
	lensCell(
		g,
		"OVERFLOW",
		run({
			status: "checking",
			verdict: "pending",
			name: "A planner-written lane name long enough to truncate",
			progressNote: "a progress note long enough to truncate on a 146px node",
			elapsedSeconds: 128.75,
		}),
	)

	g.section("LENS · OVERFLOW NODE")
	overflowCell(g, "ONE HIDDEN", 1)
	overflowCell(g, "TWO HIDDEN", 2)
	overflowCell(g, "TWELVE HIDDEN", 12)

	/* --- pending verdict ------------------------------------------------------ */

	g.section("PENDING VERDICT")
	pendingVerdictCell(g, "WITH NOTE", "AWAITING VERDICT", "4 candidates, ranking")
	pendingVerdictCell(g, "NO NOTE", "AWAITING VERDICT", null)
	pendingVerdictCell(g, "VALIDATING", "VALIDATING", "checking the top candidate")

	/* --- actions -------------------------------------------------------------- */

	g.section("ACTION · KIND")
	let ordinal = 0
	for (const kind of Object.keys(ACTION_GLYPH) as Array<ActionKind>) {
		ordinal += 1
		actionCell(g, kind.toUpperCase(), {
			kind,
			ordinal: String(ordinal).padStart(2, "0"),
			text: `${ACTION_GLYPH[kind].label} — what this kind of action reads like`,
		})
	}

	g.section("ACTION · TARGET & PROMISE")
	actionCell(g, "NO TARGET", { kind: "rollback", text: "Roll back deploy 8f21c on checkout-api" })
	actionCell(g, "WITH TARGET", {
		kind: "alert",
		text: "Alert on pool_active / pool_max > 0.8",
		target: { label: "CREATE ALERT", href: "/alerts" },
	})
	actionCell(g, "PULL REQ PROMISE", {
		kind: "code",
		text: "Add a bounded retry to the payments client",
		promise: "PULL REQ · SOON",
		target: { label: "VIEW SERVICE", href: "/services/checkout-api" },
	})
	actionCell(g, "OVERFLOW", {
		kind: "config",
		ordinal: "10",
		text: LONG_ACTION,
		target: { label: "OPEN DASHBOARDS", href: "/dashboards" },
	})

	g.section("ACTION · GHOST")
	ghostCell(g, "SLOT 0", 0)
	ghostCell(g, "SLOT 1", 1)

	/* --- edges ---------------------------------------------------------------- */

	g.section("EDGE · KIND")
	edgeCell(g, "CAUSAL · BARE", { kind: "causal" })
	edgeCell(g, "CAUSAL · LABELLED", { kind: "causal", label: "SEEDED" })
	edgeCell(g, "CAUSAL · LIVE", { kind: "causal", label: "RUNNING", live: true })
	edgeCell(g, "FAN", { kind: "fan" })
	edgeCell(g, "FAN · LIVE", { kind: "fan", live: true })
	edgeCell(g, "ROADMAP", { kind: "roadmap", label: "AUTOFIX" })
	edgeCell(g, "ROADMAP · LIVE", { kind: "roadmap", label: "AUTOFIX", live: true })

	const { y, rowHeight } = g.bounds()
	return { nodes: g.nodes, edges: g.edges, width: ROW_MAX, height: y + rowHeight }
}
