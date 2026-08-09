/**
 * The overview's causal chain, as data.
 *
 * One left-to-right graph — what caused this investigation → what it did → what
 * it concluded → what it proposes. Everything here is derived from fields already
 * on the v2 wire; nothing is invented, and a column with no source simply isn't
 * emitted rather than rendering an empty placeholder.
 *
 * Deliberately free of React and of `@xyflow/react` runtime imports: the layout
 * is arithmetic over a fixed column grid, and keeping it that way is what lets
 * the shape rules (which node kinds appear, how the lens column collapses) be
 * unit-tested without mounting a canvas.
 */
import type { V2Investigation } from "@maple/domain/http/v2"
import { formatNumber } from "@maple/ui/lib/format"
import { toEpochMs } from "@maple/ui/lib/time-format"

import { lensCopy } from "../lens-catalogue"
import {
	type LensRun,
	type LensNodeState,
	checksHeld,
	lensChecks,
	lensNodeState,
	lensTally,
} from "../lens-derive"
import { splitDuration } from "../investigation-display"
import {
	classifyAction,
	routingContextFromInvestigation,
	type ActionKind,
	type ActionTarget,
} from "./action-target"

/* -------------------------------------------------------------------------------------------------
 * Geometry
 *
 * Taken from the Paper frame rather than eyeballed: spine nodes are 146 wide with
 * a 52px gutter (146 + 52 = 198 between column origins), lens nodes 146×52, the
 * actions column 280. The right edge lands at 990 + 280 = 1270, the width of the
 * design's graph frame.
 * -----------------------------------------------------------------------------------------------*/

export const SPINE_WIDTH = 146
export const LENS_WIDTH = 146
export const ACTION_WIDTH = 280
const GUTTER = 52

/**
 * Two heights, both grown by one row for the relative-time footer every spine
 * card carries along its bottom edge.
 */
const SPINE_HEIGHT = 112
/** The investigation and verdict nodes are one step taller — they carry an extra line. */
const SPINE_HEIGHT_TALL = 128
/**
 * A running investigation node is taller again: it carries a phase line the
 * finished one has no row for, and the card clips at its border rather than
 * growing, so an unbudgeted row silently eats the timestamp under it.
 */
const SPINE_HEIGHT_LIVE = 148
/**
 * One row taller than the design's 52 to hold a running lane's progress note.
 * Uniform across the column rather than per-state: the layout centres a column by
 * summing one height per node, and a fan whose rows changed height every poll
 * would walk up and down the canvas as lanes settled.
 */
const LENS_HEIGHT = 64
const LENS_GAP = 8
const ACTION_HEIGHT = 76
const ACTION_GAP = 8
const HEADING_HEIGHT = 12
/** Column headings ride 20px above their column's top edge. */
const HEADING_OFFSET = 20

/** Above five lenses the column collapses to the top four plus a "+N more" node. */
const LENS_VISIBLE_MAX = 4
const LENS_COLLAPSE_ABOVE = 5

/* -------------------------------------------------------------------------------------------------
 * Node model
 * -----------------------------------------------------------------------------------------------*/

export type FlowTone = "muted" | "primary" | "success" | "info" | "warning" | "destructive"

/** Which glyph the node renders. Kind is carried by the icon, the tile and the fill — never colour alone. */
export type FlowGlyph = "issue" | "check" | "incident" | "investigation" | "verdict"

export interface SpineNodeData {
	readonly glyph: FlowGlyph
	readonly eyebrow: string
	readonly title: string
	/** Hover text when the node's identifier is worth having but not worth printing. */
	readonly titleHint?: string
	/** The small status word under the title, when the row has one. */
	readonly status?: string
	readonly statusTone?: FlowTone
	readonly detail?: string
	/** A second muted line, used by the investigation node's "you are here". */
	readonly note?: string
	/**
	 * The instant this step happened, stamped along the bottom of the card as
	 * relative time. Absent on steps that have no instant on the wire rather than
	 * borrowed from a neighbour — two adjacent cards reading "6h ago" off the same
	 * timestamp would imply a gap that was measured.
	 */
	readonly at?: string
	/** In-app destination, when the node points at one. */
	readonly href?: string
	/** The one lifted, amber-tiled node: the investigation you are looking at. */
	readonly current?: boolean
	/** The verdict node is the only muted-fill node — one step up from the canvas. */
	readonly lifted?: boolean
	/** This step is happening right now — the node rings and its strands march. */
	readonly live?: boolean
	/** What the live step is doing, e.g. `FANNING OUT · 2/4 REPORTED`. Only set while `live`. */
	readonly phase?: string
}

export interface LensNodeData {
	readonly title: string
	readonly question: string
	/** The validator's own sentence for this lane — hover text, not a printed row. */
	readonly result: string
	readonly state: LensNodeState
	readonly elapsed: string | null
	/**
	 * What the lane is doing right now, printed while it runs.
	 *
	 * It was already on the wire and already derived — `lensChecks` reads it for
	 * the rail — but on this canvas it only ever reached a `title` tooltip, which
	 * is the one place a reader watching a run in progress will not look.
	 */
	readonly progressNote: string | null
}

export interface LensOverflowNodeData {
	readonly hidden: number
}

/**
 * The step after the fan, while there is no verdict to show.
 *
 * It states the *process* and never a result: no suspected cause, no confidence,
 * no timestamp. A placeholder verdict would be a claim the run has not made; a
 * placeholder step is the structure the run is still moving through, and without
 * it the chain simply stops mid-air at the fan.
 */
export interface PendingVerdictNodeData {
	readonly word: string
	readonly note: string | null
}

export interface ActionNodeData {
	/** Zero-based position in `report.suggestedActions` — the detail panel's identity, and its URL key. */
	readonly index: number
	readonly ordinal: string
	readonly text: string
	/** What shape of work this is, so the node can carry a glyph for it. */
	readonly kind: ActionKind
	readonly target: ActionTarget | null
	/** Static roadmap chip — a promise attached to a real handle, not a node of its own. */
	readonly promise: "AUTOFIX · SOON" | "PULL REQ · SOON"
	/**
	 * Injected by the canvas when it maps these to xyflow nodes, never by the
	 * builder — `buildProvenanceGraph` stays a pure function of the investigation,
	 * which is what lets it be tested without a renderer.
	 */
	readonly onOpen?: (index: number) => void
}

export type ProvenanceNode =
	| { id: string; type: "spine"; position: XY; width: number; height: number; data: SpineNodeData }
	| { id: string; type: "lens"; position: XY; width: number; height: number; data: LensNodeData }
	| {
			id: string
			type: "lensOverflow"
			position: XY
			width: number
			height: number
			data: LensOverflowNodeData
	  }
	| {
			id: string
			type: "pendingVerdict"
			position: XY
			width: number
			height: number
			data: PendingVerdictNodeData
	  }
	| { id: string; type: "action"; position: XY; width: number; height: number; data: ActionNodeData }
	| {
			id: string
			type: "heading"
			position: XY
			width: number
			height: number
			data: { readonly text: string }
	  }

export interface XY {
	readonly x: number
	readonly y: number
}

export type EdgeKind = "causal" | "fan" | "roadmap"

export interface ProvenanceEdge {
	readonly id: string
	readonly source: string
	readonly target: string
	readonly kind: EdgeKind
	/** Rendered above the line, never on it. Only causal and roadmap edges carry one. */
	readonly label?: string
	/**
	 * This strand feeds work that has not finished — the one thing on the canvas
	 * allowed to move.
	 *
	 * Every strand used to march, which meant a diagnosis from last Tuesday
	 * animated exactly as hard as a run happening now and motion carried no
	 * information at all. Liveness is a property of the strand's *target*: the
	 * step it is delivering into is the step still being worked on.
	 */
	readonly live?: boolean
}

export interface ProvenanceGraph {
	readonly nodes: ReadonlyArray<ProvenanceNode>
	readonly edges: ReadonlyArray<ProvenanceEdge>
	readonly width: number
	readonly height: number
	/** Column heading above the lens fan, e.g. `FANNED OUT · 4 LENSES`. Null when there was no fan-out. */
	readonly lensHeading: string | null
	/** Column heading above the actions column. Null when the report proposed nothing. */
	readonly actionHeading: string | null
	/** `14:02 → 14:03 · 38s`, or as much of it as the timestamps carry. */
	readonly caption: string | null
	/**
	 * When a still-running pass opened, so the caption can tick against it.
	 *
	 * The epoch instant rather than the formatted duration: this builder is a pure
	 * function of the investigation and its tests would need a frozen clock the
	 * moment it read `Date.now()`. The component owns the tick.
	 */
	readonly runningSince: number | null
}

/* -------------------------------------------------------------------------------------------------
 * Builder
 * -----------------------------------------------------------------------------------------------*/

/**
 * Columns are assembled first as lists, then positioned — so a freeform
 * investigation (no issue, no incident) starts at x=0 instead of leaving two
 * empty columns' worth of dead canvas on the left.
 */
export function buildProvenanceGraph(investigation: V2Investigation): ProvenanceGraph {
	const { subject, snapshot, report } = investigation
	const columns: Array<{ nodes: Array<ProvenanceNode>; width: number }> = []
	const edges: Array<ProvenanceEdge> = []
	const running = investigation.status === "investigating"
	/**
	 * The nodes whose work is still open. Collected as the columns are built and
	 * resolved into edges at the end, because a strand's liveness is its target's
	 * and the target does not exist yet when the strand is pushed.
	 */
	const liveIds = new Set<string>()

	/** Ids of the nodes the next column's edges originate from. */
	let upstream: Array<string> = []
	let nextLabel: string | undefined

	const pushColumn = (nodes: Array<ProvenanceNode>, width: number, kind: EdgeKind) => {
		if (nodes.length === 0) return
		// A fan into many nodes, or a merge out of many, carries its label on the
		// column heading instead — the same word repeated on four strands is noise.
		const label = upstream.length === 1 && nodes.length === 1 ? nextLabel : undefined
		for (const source of upstream) {
			for (const node of nodes) {
				edges.push({
					id: `${source}->${node.id}`,
					source,
					target: node.id,
					kind,
					...(label ? { label } : {}),
				})
			}
		}
		columns.push({ nodes, width })
		upstream = nodes.map((node) => node.id)
		nextLabel = undefined
	}

	/* --- origin: issue (or, for an alert, the check that fired) -------------- */

	const issueId = subject.type === "incident" ? subject.issue_id : null
	const isAlert = subject.type === "incident" && subject.incident_kind === "alert"

	if (subject.type === "incident" && (issueId || isAlert)) {
		const occurrences = snapshot.occurrenceCount
		const origin: ProvenanceNode = {
			id: "origin",
			type: "spine",
			position: { x: 0, y: 0 },
			width: SPINE_WIDTH,
			height: SPINE_HEIGHT,
			data: {
				glyph: isAlert ? "check" : "issue",
				eyebrow: isAlert ? "CHECK" : "ISSUE",
				title: originTitle(investigation) ?? issueId ?? "—",
				status: snapshot.status.toUpperCase(),
				statusTone: "destructive",
				...(occurrences != null && Number.isFinite(occurrences)
					? { detail: `· ${formatNumber(occurrences)} events` }
					: {}),
				...(issueId ? { href: `/errors/issues/${issueId}` } : {}),
			},
		}
		pushColumn([origin], SPINE_WIDTH, "causal")
		nextLabel = isAlert ? "TRIPPED" : "FLARED INTO"
	}

	/* --- incident ------------------------------------------------------------ */

	if (subject.type === "incident") {
		pushColumn(
			[
				{
					id: "incident",
					type: "spine",
					position: { x: 0, y: 0 },
					width: SPINE_WIDTH,
					height: SPINE_HEIGHT,
					data: {
						glyph: "incident",
						eyebrow: "INCIDENT",
						title: incidentTitle(investigation),
						// The id is a 36-character UUID once the wire's `inc_…` public id
						// is decoded. It belongs in the tooltip, not on a 146px node.
						titleHint: subject.incident_id,
						status: snapshot.status.toUpperCase(),
						statusTone: "destructive",
						// No clock time beside the status any more — the footer states
						// the same instant relatively, and carrying both put "10:12 AM"
						// and "6h ago" two lines apart saying one thing twice.
						...(snapshot.incidentStartedAt ? { at: snapshot.incidentStartedAt } : {}),
					},
				},
			],
			SPINE_WIDTH,
			"causal",
		)
		nextLabel = "OPENED"
	}

	/* --- the investigation itself — the only amber node ---------------------- */

	const elapsed = elapsedLabel(investigation)
	pushColumn(
		[
			{
				id: "investigation",
				type: "spine",
				position: { x: 0, y: 0 },
				width: SPINE_WIDTH,
				height: running ? SPINE_HEIGHT_LIVE : SPINE_HEIGHT_TALL,
				data: {
					glyph: "investigation",
					eyebrow: "INVESTIGATION",
					// How the run went, not which run it is. The id is a UUID once
					// decoded, and "you are here" already answers "which one".
					title: INVESTIGATION_TITLE[investigation.status] ?? investigation.status,
					titleHint: investigation.id,
					at: investigation.created_at,
					// "manual", not "opened by you": the node is 146px wide and carries a
					// second line ("you are here") under this one, so a note that wraps to
					// two lines pushes the id out through the bottom of the box.
					note: [investigation.seeded_by === "system" ? "automatic" : "manual", elapsed]
						.filter(Boolean)
						.join(" · "),
					current: true,
					...(running ? { live: true, phase: livePhase(investigation) } : {}),
				},
			},
		],
		SPINE_WIDTH,
		"causal",
	)
	if (running) liveIds.add("investigation")

	/* --- the lens fan -------------------------------------------------------- */

	const { visible, hidden } = selectLenses(investigation.lens_runs)
	// `lensChecks` returns one entry per lane in the order given, so this is the
	// validator's own sentence for each visible lane. It used to be the checks
	// rail's second line; with the rail gone it is the node's hover text, and it is
	// the only place the *reason* a lane held or didn't survives on this tab.
	const results = lensChecks(visible)
	const lensNodes: Array<ProvenanceNode> = visible.map((run, index) => {
		const id = `lens-${run.lensId}-${index}`
		// A queued lane is live too: nothing has happened on it yet, which is
		// precisely why its strand should not read as settled.
		if (run.status === "checking" || run.status === "queued") liveIds.add(id)
		return {
			id,
			type: "lens" as const,
			position: { x: 0, y: 0 },
			width: LENS_WIDTH,
			height: LENS_HEIGHT,
			data: {
				title: lensCopy(run).name,
				question: run.question ?? "",
				result: results[index]?.result ?? "",
				state: lensNodeState(run),
				elapsed: run.elapsedSeconds == null ? null : `${run.elapsedSeconds.toFixed(1)}s`,
				progressNote: run.progressNote,
			},
		}
	})
	if (hidden > 0) {
		lensNodes.push({
			id: "lens-overflow",
			type: "lensOverflow",
			position: { x: 0, y: 0 },
			width: LENS_WIDTH,
			height: LENS_HEIGHT,
			data: { hidden },
		})
	}
	if (lensNodes.length > 0) {
		nextLabel = "FANNED OUT"
		pushColumn(lensNodes, LENS_WIDTH, "fan")
	}

	/* --- verdict ------------------------------------------------------------- */

	/*
	 * Still absent while the pass is running: a placeholder *verdict* is a claim
	 * the investigation has not made yet. What stands in its place is a node about
	 * the process rather than the finding — see `PendingVerdictNodeData`.
	 */
	if (running && lensNodes.length > 0) {
		pushColumn(
			[
				{
					id: "pending-verdict",
					type: "pendingVerdict",
					position: { x: 0, y: 0 },
					width: SPINE_WIDTH,
					height: SPINE_HEIGHT_TALL,
					data: pendingVerdict(investigation),
				},
			],
			SPINE_WIDTH,
			"fan",
		)
		liveIds.add("pending-verdict")
	} else if (!running && report) {
		pushColumn(
			[
				{
					id: "verdict",
					type: "spine",
					position: { x: 0, y: 0 },
					width: SPINE_WIDTH,
					height: SPINE_HEIGHT_TALL,
					data: {
						glyph: "verdict",
						eyebrow: "VERDICT",
						title: report.suspectedCause,
						note: `${report.confidence} confidence`,
						...(investigation.diagnosed_at ? { at: investigation.diagnosed_at } : {}),
						lifted: true,
					},
				},
			],
			SPINE_WIDTH,
			"fan",
		)
	}

	/* --- proposed actions ---------------------------------------------------- */

	const actions = report?.suggestedActions ?? []
	if (actions.length > 0 && investigation.status !== "investigating") {
		nextLabel = "PROPOSES"
		pushColumn(
			actions.map((action, index) => ({
				id: `action-${index}`,
				type: "action" as const,
				position: { x: 0, y: 0 },
				width: ACTION_WIDTH,
				height: ACTION_HEIGHT,
				data: {
					index,
					ordinal: String(index + 1).padStart(2, "0"),
					text: action,
					...classifyAction(action, routingContextFromInvestigation(investigation)),
					promise: index === actions.length - 1 ? "PULL REQ · SOON" : "AUTOFIX · SOON",
				},
			})),
			ACTION_WIDTH,
			"roadmap",
		)
	}

	/* --- position ------------------------------------------------------------ */

	const columnHeight = (column: { nodes: Array<ProvenanceNode> }): number => {
		const gap = column.nodes[0]?.type === "action" ? ACTION_GAP : LENS_GAP
		return column.nodes.reduce((total, node, index) => total + node.height + (index ? gap : 0), 0)
	}
	const height = Math.max(0, ...columns.map(columnHeight))

	const lensHeading = lensColumnHeading(investigation)
	const actionHeading =
		actions.length > 0 && investigation.status !== "investigating"
			? `PROPOSES · ${actions.length} ${actions.length === 1 ? "ACTION" : "ACTIONS"} BY IMPACT`
			: null

	const headings: Array<ProvenanceNode> = []
	let x = 0
	for (const column of columns) {
		const gap = column.nodes[0]?.type === "action" ? ACTION_GAP : LENS_GAP
		const top = (height - columnHeight(column)) / 2
		let y = top
		for (const node of column.nodes) {
			;(node as { position: XY }).position = { x, y }
			y += node.height + gap
		}
		// The two multi-node columns carry their count as a heading; the spine
		// columns say what they are on the node itself.
		const kind = column.nodes[0]?.type
		const text = kind === "action" ? actionHeading : kind === "lens" ? lensHeading : null
		if (text) {
			headings.push({
				id: `heading-${kind}`,
				type: "heading",
				position: { x, y: top - HEADING_OFFSET },
				width: column.width,
				height: HEADING_HEIGHT,
				data: { text },
			})
		}
		x += column.width + GUTTER
	}

	const openedMs = toEpochMs(investigation.created_at)

	return {
		nodes: [...headings, ...columns.flatMap((column) => column.nodes)],
		edges: edges.map((edge) => (liveIds.has(edge.target) ? { ...edge, live: true } : edge)),
		width: Math.max(0, x - GUTTER),
		height,
		lensHeading,
		actionHeading,
		caption: caption(investigation),
		runningSince: running && Number.isFinite(openedMs) ? openedMs : null,
	}
}

/* -------------------------------------------------------------------------------------------------
 * Derivations
 * -----------------------------------------------------------------------------------------------*/

/**
 * The top four by planner priority, with the rest folded into one node.
 *
 * Priority ascends (1 is highest), and lanes written before the planner carry
 * none — those sort last but keep their dispatch order, so the column is never
 * reshuffled arbitrarily. Below the collapse threshold every lane is shown: four
 * strands and a "+1 more" reads worse than five strands.
 */
export function selectLenses(runs: ReadonlyArray<LensRun>): {
	visible: ReadonlyArray<LensRun>
	hidden: number
} {
	if (runs.length <= LENS_COLLAPSE_ABOVE) return { visible: runs, hidden: 0 }
	const ranked = runs
		.map((run, index) => ({ run, index }))
		.sort((a, b) => {
			const left = a.run.priority ?? Number.POSITIVE_INFINITY
			const right = b.run.priority ?? Number.POSITIVE_INFINITY
			return left - right || a.index - b.index
		})
		.slice(0, LENS_VISIBLE_MAX)
		// Back into dispatch order, so the fan reads top-to-bottom as it ran.
		.sort((a, b) => a.index - b.index)
	return { visible: ranked.map((entry) => entry.run), hidden: runs.length - ranked.length }
}

/** The name the origin node prints — the exception, not the opaque `iss_…`. */
const originTitle = (investigation: V2Investigation): string | null => {
	const { snapshot } = investigation
	const candidate = snapshot.errorLabel ?? snapshot.exceptionType ?? snapshot.title
	const text = candidate?.trim()
	return text ? text : null
}

/**
 * `FANNED OUT · 4 LENSES · 1 HELD`.
 *
 * The held count was the checks rail's header, and it is the fastest read of
 * whether the verdict deserves trust — so when the rail went it came here rather
 * than being lost. It is withheld until the validator has actually ranked: "0
 * held" printed over four still-running lanes states a result nobody reached.
 */
const lensColumnHeading = (investigation: V2Investigation): string | null => {
	const lenses = investigation.lens_runs
	if (lenses.length === 0) return null
	const base = `FANNED OUT · ${lenses.length} ${lenses.length === 1 ? "LENS" : "LENSES"}`
	const status = investigation.validator?.status
	if (status !== "ranked" && status !== "rejected_all") return base
	return `${base} · ${checksHeld(lensChecks(lenses))} HELD`
}

/**
 * What the incident *was*, not what it is called.
 *
 * The design put `inc_8Kd21mQr` here because a 12-character public id is a handle
 * a person can carry to a support thread. Ours is not that: `incident_id` is an
 * `inc_…` public id on the wire, but the schema decodes it back to the underlying
 * 36-character UUID, so the node was printing `88888888-8888-4888-8888-…` across
 * two wrapped lines. That is not a handle, it is noise — the id moves to the
 * tooltip and the node says what fired.
 */
const incidentTitle = (investigation: V2Investigation): string => {
	const { snapshot, subject } = investigation
	const signal = snapshot.facts.find((fact) => fact.label.toLowerCase() === "signal")?.value.trim()
	if (signal) return signal
	const scope = snapshot.scope?.trim()
	if (scope) return scope
	return subject.type === "incident" ? `${subject.incident_kind} incident` : "Incident"
}

/**
 * Which stage a running pass is in, for the amber node's second line.
 *
 * `running` is checked before the validator, because `blocked` means "the
 * validator has nothing to rank yet" and is set for the whole time the lanes are
 * still reporting — reading it first would label a fan-out mid-flight
 * "VALIDATING", which is the one stage it demonstrably is not in.
 */
const livePhase = (investigation: V2Investigation): string => {
	const state = investigation.fanout?.state
	if (state === "queued") return "QUEUEING"
	if (state === "running") {
		const tally = lensTally(investigation.lens_runs)
		// The bare ratio, not "1/3 REPORTED": the node is 146px and the longer form
		// truncated to "FANNING OUT · 1/3…", losing the word it was spent on. What
		// the ratio counts is stated by the fan it sits next to.
		return tally.total > 0 ? `FANNING OUT · ${tally.settled}/${tally.total}` : "FANNING OUT"
	}
	if (state === "validating" || investigation.validator?.status === "blocked") return "VALIDATING"
	// The single-pass path — a freeform question, or an org that opted out of planning.
	return "RUNNING"
}

/**
 * The ghost step's two lines. Both describe work, never a finding: `settled`
 * counts lanes that will not change again, which is the same number the fan is
 * showing, so the two cannot disagree.
 */
const pendingVerdict = (investigation: V2Investigation): PendingVerdictNodeData => {
	const tally = lensTally(investigation.lens_runs)
	const validating =
		investigation.fanout?.state === "validating" || (tally.total > 0 && tally.settled === tally.total)
	return {
		word: validating ? "VALIDATING" : "AWAITING VERDICT",
		note: tally.total > 0 ? `${tally.settled} of ${tally.total} lenses reported` : null,
	}
}

/** The run's outcome, which is the one thing the canvas doesn't say anywhere else. */
const INVESTIGATION_TITLE: Record<string, string> = {
	investigating: "In progress",
	diagnosed: "Diagnosed",
	resolved: "Resolved",
	failed: "Failed",
}

const elapsedLabel = (investigation: V2Investigation): string | null => {
	const openedMs = toEpochMs(investigation.created_at)
	const endedAt =
		investigation.diagnosed_at ?? (investigation.status === "failed" ? investigation.updated_at : null)
	if (!endedAt) return null
	const endMs = toEpochMs(endedAt)
	if (!Number.isFinite(openedMs) || !Number.isFinite(endMs) || endMs < openedMs) return null
	const elapsed = splitDuration(endMs - openedMs)
	return `${elapsed.value}${elapsed.unit}`
}

/** `14:02 → 14:03 · 38s` across the top of the canvas. */
const caption = (investigation: V2Investigation): string | null => {
	const opened = clockTime(investigation.created_at)
	if (!opened) return null
	const endedAt =
		investigation.diagnosed_at ?? (investigation.status === "failed" ? investigation.updated_at : null)
	const ended = clockTime(endedAt)
	const elapsed = elapsedLabel(investigation)
	if (!ended) return `${opened} → running`
	return `${opened} → ${ended}${elapsed ? ` · ${elapsed}` : ""}`
}

const clockTime = (value: string | null | undefined): string | null => {
	if (!value) return null
	const ms = toEpochMs(value)
	if (!Number.isFinite(ms)) return null
	return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}
