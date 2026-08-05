import type { Schema } from "effect"
import type { JourneyEvent, JourneyListItem } from "@maple/domain/http"

import { agentColor, parseWarehouseTimestamp } from "./journey-format"

// ---------------------------------------------------------------------------
// The timeline's row model.
//
// The wire format is deliberately ONE struct discriminated by `kind` rather
// than a union, because the GenAI conventions keep adding operations
// (`retrieval`, `plan`, memory, `invoke_agent`). This module keeps that
// property: it lowers events into three *archetypes* — message block, tool
// table, structural bar — and an operation it has never heard of falls through
// to the structural bar carrying its own label. A new event kind is a label and
// a payload, never a new component.
//
// Everything here is derivation only. Cumulative `gen_ai.input.messages` are
// already deduped server-side and tool calls already carry `parentEventId`; we
// nest, measure and group, we do not re-assemble.
// ---------------------------------------------------------------------------

export type JourneyEventData = Schema.Schema.Type<typeof JourneyEvent>
export type JourneySummaryData = Schema.Schema.Type<typeof JourneyListItem>

/** How a slice of wall-clock time was spent — the vocabulary of the time band, the journey map and the group sparkbars. */
export type JourneySpanCategory = "model" | "tool" | "failed" | "idle"

export interface JourneyTimeSegment {
	readonly key: string
	readonly category: JourneySpanCategory
	/** Percent of the journey's wall clock, 0–100. */
	readonly startPct: number
	readonly widthPct: number
}

export interface JourneyMapBar {
	readonly rowId: string
	readonly category: JourneySpanCategory
	/** Percent of the widest row's duration, 4–100 so a fast turn still reads as a bar. */
	readonly widthPct: number
	readonly laneColor: string | null
}

/** One agent's share of the journey. Derived per-agent, because the summary only carries the name set. */
export interface JourneyAgentStat {
	readonly name: string
	readonly color: string
	readonly turns: number
	readonly cost: number | null
	readonly tokens: number
}

export interface JourneyModelStat {
	readonly name: string
	readonly turns: number
	readonly cost: number | null
}

export interface JourneyTokenBreakdown {
	readonly cachedInput: number
	readonly freshInput: number
	readonly reasoning: number
	readonly visibleOutput: number
	readonly total: number
	/** 0–1, or `null` when there is no input at all to take a share of. */
	readonly cachedShare: number | null
}

interface JourneyRowBase {
	readonly id: string
	/** ms since the journey's first event. */
	readonly offsetMs: number
	readonly durationMs: number | null
	/**
	 * The agent whose nested lane this row runs inside, or `null` at top level.
	 * Set for rows between an `invoke_agent` operation and that agent's return.
	 */
	readonly laneColor: string | null
}

export interface JourneyMessageRow extends JourneyRowBase {
	readonly type: "message"
	readonly event: JourneyEventData
	readonly toolCalls: ReadonlyArray<JourneyEventData>
	/** 1-based position among message rows — what the design calls a "turn". */
	readonly turn: number
}

export interface JourneyStructuralRow extends JourneyRowBase {
	readonly type: "structural"
	readonly event: JourneyEventData
	/** `HANDOFF`, `PLAN`, `RETRIEVAL`, `MEMORY · SEARCH`, … */
	readonly label: string
}

export interface JourneyIdleRow extends JourneyRowBase {
	readonly type: "idle"
	readonly reason: string
}

/** A run of unremarkable turns, folded away on a journey too long to read straight through. */
export interface JourneyTurnGroupRow extends JourneyRowBase {
	readonly type: "turnGroup"
	readonly rows: ReadonlyArray<JourneyRow>
	readonly firstTurn: number
	readonly lastTurn: number
	readonly agentNames: ReadonlyArray<string>
	readonly toolCallCount: number
	readonly cost: number | null
	readonly segments: ReadonlyArray<JourneyTimeSegment>
}

export type JourneyRow = JourneyMessageRow | JourneyStructuralRow | JourneyIdleRow | JourneyTurnGroupRow

export interface JourneyModel {
	readonly systemPrompt: JourneyEventData | null
	readonly rows: ReadonlyArray<JourneyRow>
	readonly startMs: number
	readonly endMs: number
	readonly totalMs: number
	readonly agents: ReadonlyArray<JourneyAgentStat>
	readonly models: ReadonlyArray<JourneyModelStat>
	/** Turns whose served model differed from the one requested — the router divergence. */
	readonly divergentModelTurns: number
	readonly tokens: JourneyTokenBreakdown
	readonly segments: ReadonlyArray<JourneyTimeSegment>
	readonly timeTotals: Record<JourneySpanCategory, number>
	readonly mapBars: ReadonlyArray<JourneyMapBar>
	/** The longest single row in the journey — what the map bars and the redacted
	 *  timing bars scale against, so both read as one distribution. */
	readonly maxRowDurationMs: number
	readonly counts: {
		readonly turns: number
		readonly errors: number
		readonly handoffs: number
		readonly toolFailures: number
	}
	/** True when not one event carried message text — the whole journey renders redacted. */
	readonly allContentAbsent: boolean
	/** True when content exists but only in span events, which we don't read yet. */
	readonly contentInEvents: boolean
}

/**
 * Gaps shorter than this aren't worth a row — sub-second dead time between
 * spans is scheduling noise, not think-time, and a row per gap would double the
 * timeline's length for nothing.
 */
const IDLE_THRESHOLD_MS = 3_000

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildJourneyModel(
	events: ReadonlyArray<JourneyEventData>,
	summary: JourneySummaryData | null,
): JourneyModel {
	const ordered = [...events].sort((a, b) => {
		const at = parseWarehouseTimestamp(a.timestamp) ?? 0
		const bt = parseWarehouseTimestamp(b.timestamp) ?? 0
		return at - bt
	})

	const systemPrompt = ordered.find((event) => event.kind === "systemPrompt") ?? null

	// Tool calls nest under the assistant message that requested them. An
	// unresolvable parent (the server couldn't match a call id, or the parent
	// fell outside a truncated page) is promoted to a top-level row rather than
	// dropped — a tool call that ran is a fact, whatever it hung off.
	const eventIds = new Set(ordered.map((event) => event.id))
	const toolCallsByParent = new Map<string, Array<JourneyEventData>>()
	for (const event of ordered) {
		if (event.kind !== "toolCall") continue
		const parentId = event.parentEventId
		if (!parentId || !eventIds.has(parentId)) continue
		const bucket = toolCallsByParent.get(parentId)
		if (bucket) bucket.push(event)
		else toolCallsByParent.set(parentId, [event])
	}

	const timelineEvents = ordered.filter((event) => {
		if (event.kind === "systemPrompt") return false
		if (event.kind === "toolCall") {
			return !(event.parentEventId && toolCallsByParent.has(event.parentEventId))
		}
		return true
	})

	const startMs = earliestTimestamp(ordered) ?? 0
	const endMs = latestTimestamp(ordered, startMs)
	const summaryDuration = summary?.durationMs ?? null
	const totalMs = Math.max(
		1,
		summaryDuration != null && summaryDuration > 0 ? summaryDuration : endMs - startMs,
	)

	// --- Rows, with measured idle between them -----------------------------
	const rows: Array<JourneyRow> = []
	let turn = 0
	let previousEndMs: number | null = null
	const laneStack: Array<{ agentName: string; color: string }> = []

	for (const event of timelineEvents) {
		const eventStart = parseWarehouseTimestamp(event.timestamp) ?? startMs
		const offsetMs = Math.max(0, eventStart - startMs)
		const durationMs = event.durationMs ?? null

		if (previousEndMs != null) {
			const gap = eventStart - previousEndMs
			if (gap >= IDLE_THRESHOLD_MS) {
				rows.push({
					type: "idle",
					id: `idle-${event.id}`,
					offsetMs: Math.max(0, previousEndMs - startMs),
					durationMs: gap,
					laneColor: laneStack.at(-1)?.color ?? null,
					reason: idleReason(event),
				})
			}
		}

		// Lane bookkeeping. `invoke_agent` opens a nested lane; the lane closes
		// as soon as a row belongs to somebody else. There is no explicit
		// "returned" signal in the conventions, so this is structural inference,
		// not a decoded field — and it is self-correcting, because the very next
		// row from another agent closes it.
		if (isInvokeAgent(event) && event.agentName) {
			laneStack.push({ agentName: event.agentName, color: agentColor(event.agentName) })
		} else if (
			laneStack.length > 0 &&
			event.agentName &&
			event.agentName !== laneStack.at(-1)?.agentName
		) {
			laneStack.pop()
		}
		const laneColor = isInvokeAgent(event) ? null : (laneStack.at(-1)?.color ?? null)

		if (event.kind === "message") {
			turn += 1
			rows.push({
				type: "message",
				id: event.id,
				offsetMs,
				durationMs,
				laneColor,
				event,
				turn,
				toolCalls: toolCallsByParent.get(event.id) ?? [],
			})
		} else {
			rows.push({
				type: "structural",
				id: event.id,
				offsetMs,
				durationMs,
				laneColor,
				event,
				label: structuralLabel(event),
			})
		}

		previousEndMs = eventStart + (durationMs ?? 0)
		for (const toolCall of toolCallsByParent.get(event.id) ?? []) {
			const toolStart = parseWarehouseTimestamp(toolCall.timestamp)
			if (toolStart == null) continue
			previousEndMs = Math.max(previousEndMs, toolStart + (toolCall.durationMs ?? 0))
		}
	}

	// --- Derived aggregates -------------------------------------------------
	const agents = buildAgentStats(ordered)
	const models = buildModelStats(ordered)
	const segments = buildSegments(ordered, startMs, totalMs)
	const timeTotals = buildTimeTotals(segments, totalMs)
	const tokens = buildTokenBreakdown(summary, ordered)

	const maxRowDuration = rows.reduce((max, row) => Math.max(max, row.durationMs ?? 0), 0)
	const mapBars = rows
		.filter((row) => row.type !== "idle")
		.map((row) => ({
			rowId: row.id,
			category: rowCategory(row),
			widthPct: maxRowDuration > 0 ? Math.max(4, ((row.durationMs ?? 0) / maxRowDuration) * 100) : 8,
			laneColor: row.laneColor,
		}))

	return {
		systemPrompt,
		rows,
		startMs,
		endMs,
		totalMs,
		agents,
		models,
		divergentModelTurns: ordered.filter(
			(event) =>
				event.kind === "message" &&
				event.model != null &&
				event.requestedModel != null &&
				event.model !== event.requestedModel,
		).length,
		tokens,
		segments,
		timeTotals,
		mapBars,
		maxRowDurationMs: maxRowDuration,
		counts: {
			// A "turn" is an agent turn — the unit the overview row, the header, the
			// rail's per-agent/per-model tallies and the warehouse summary all count.
			// `turn` above is a row ordinal that also advances on user messages, so
			// using it here made the rail claim "8 turns" next to "gpt-4o · 4 turns".
			turns: summary?.turnCount ?? countAgentTurns(ordered),
			errors: rows.filter((row) => row.type !== "idle" && rowHasError(row)).length,
			handoffs: ordered.filter((event) => event.kind === "agentHandoff" || isInvokeAgent(event)).length,
			toolFailures: ordered.filter((event) => event.kind === "toolCall" && event.status === "error")
				.length,
		},
		allContentAbsent:
			ordered.length > 0 &&
			ordered.every((event) => event.content == null || event.contentSource !== "attributes"),
		contentInEvents:
			(summary?.contentInEvents ?? false) || ordered.some((event) => event.contentSource === "events"),
	}
}

// ---------------------------------------------------------------------------
// View: filtering, search, and long-journey condensation
// ---------------------------------------------------------------------------

export type JourneyTimelineFilter = "all" | "errors" | "handoffs" | "toolFailures"

/**
 * Past this many rows a journey stops being something you scroll and starts
 * being something you navigate. Runs of unremarkable turns fold into a group
 * row so the notable ones — errors, handoffs, tool failures — stay on screen.
 */
const CONDENSE_ROW_THRESHOLD = 48
/** Shorter runs than this aren't worth folding; the group row costs as much height. */
const MIN_GROUP_RUN = 4
/** Always leave the opening and closing turns expanded — that's where you start and finish reading. */
const ALWAYS_EXPANDED_EDGE = 3

export interface JourneyTimelineView {
	readonly rows: ReadonlyArray<JourneyRow>
	/** True when condensation actually folded something, so the UI can say so. */
	readonly condensed: boolean
	readonly hiddenTurnCount: number
}

export function buildTimelineView(
	model: JourneyModel,
	options: {
		readonly filter: JourneyTimelineFilter
		readonly query: string
		readonly expandedGroupIds: ReadonlySet<string>
		readonly condense: boolean
	},
): JourneyTimelineView {
	const filtered = applyFilter(model.rows, options.filter, options.query)
	const filterActive = options.filter !== "all" || options.query.trim().length > 0

	// A filter is already a navigation act — folding on top of it would hide the
	// very rows the filter was asked to surface.
	if (filterActive || !options.condense || filtered.length <= CONDENSE_ROW_THRESHOLD) {
		return { rows: filtered, condensed: false, hiddenTurnCount: 0 }
	}

	const out: Array<JourneyRow> = []
	let run: Array<JourneyRow> = []
	let hidden = 0

	const flush = () => {
		if (run.length === 0) return
		if (run.length < MIN_GROUP_RUN) {
			out.push(...run)
			run = []
			return
		}
		const group = makeTurnGroup(run, model)
		if (options.expandedGroupIds.has(group.id)) {
			out.push(group, ...run)
		} else {
			out.push(group)
			hidden += group.lastTurn - group.firstTurn + 1
		}
		run = []
	}

	filtered.forEach((row, index) => {
		const nearEdge = index < ALWAYS_EXPANDED_EDGE || index >= filtered.length - ALWAYS_EXPANDED_EDGE
		if (nearEdge || isNotable(row)) {
			flush()
			out.push(row)
			return
		}
		run.push(row)
	})
	flush()

	return { rows: out, condensed: hidden > 0, hiddenTurnCount: hidden }
}

function applyFilter(
	rows: ReadonlyArray<JourneyRow>,
	filter: JourneyTimelineFilter,
	query: string,
): ReadonlyArray<JourneyRow> {
	const needle = query.trim().toLowerCase()
	if (filter === "all" && needle.length === 0) return rows

	return rows.filter((row) => {
		if (row.type === "idle") return false
		if (filter === "errors" && !rowHasError(row)) return false
		if (filter === "handoffs" && !isHandoffRow(row)) return false
		if (filter === "toolFailures" && !rowHasToolFailure(row)) return false
		if (needle.length > 0 && !rowMatches(row, needle)) return false
		return true
	})
}

function rowMatches(row: JourneyRow, needle: string): boolean {
	if (row.type === "turnGroup") return row.rows.some((inner) => rowMatches(inner, needle))
	if (row.type === "idle") return false
	const event = row.event
	const haystack = [
		event.content,
		event.agentName,
		event.model,
		event.requestedModel,
		event.toolName,
		event.toolArguments,
		event.toolResult,
		event.statusMessage,
		event.operation,
		event.spanName,
		row.type === "message" ? null : row.label,
	]
	if (haystack.some((value) => value != null && value.toLowerCase().includes(needle))) return true
	if (row.type === "message") {
		return row.toolCalls.some(
			(call) =>
				(call.toolName ?? "").toLowerCase().includes(needle) ||
				(call.toolArguments ?? "").toLowerCase().includes(needle) ||
				(call.statusMessage ?? "").toLowerCase().includes(needle),
		)
	}
	return false
}

/**
 * A row worth keeping expanded on a 142-turn journey: something failed, an
 * agent changed hands, or the model finished for a reason other than "it was
 * done". A `length` finish is the silent failure the design brief calls out —
 * it looks like a normal message and must never be folded away.
 */
function isNotable(row: JourneyRow): boolean {
	if (row.type === "idle") return false
	if (row.type === "turnGroup") return false
	if (rowHasError(row) || rowHasToolFailure(row) || isHandoffRow(row)) return true
	const finish = row.event.finishReason
	return finish != null && finish !== "" && finish !== "stop" && finish !== "tool_calls"
}

function makeTurnGroup(run: ReadonlyArray<JourneyRow>, model: JourneyModel): JourneyTurnGroupRow {
	const turns = run.flatMap((row) => (row.type === "message" ? [row.turn] : []))
	const first = run[0]
	const last = run[run.length - 1]
	const spanEnd = (last.offsetMs ?? 0) + (last.durationMs ?? 0)
	const agentNames = Array.from(
		new Set(
			run.flatMap((row) =>
				row.type === "idle" || row.type === "turnGroup" ? [] : [row.event.agentName ?? ""],
			),
		),
	).filter((name) => name.length > 0)

	const costs = run.flatMap((row) =>
		row.type === "message" || row.type === "structural" ? [row.event.cost ?? null] : [],
	)
	const knownCosts = costs.filter((cost): cost is number => cost != null)

	const groupStart = first.offsetMs
	const groupSpan = Math.max(1, spanEnd - groupStart)
	const segments: Array<JourneyTimeSegment> = []
	for (const row of run) {
		if (row.type === "idle" || row.durationMs == null) continue
		segments.push({
			key: `${row.id}-seg`,
			category: rowCategory(row),
			startPct: ((row.offsetMs - groupStart) / groupSpan) * 100,
			widthPct: Math.max(0.8, (row.durationMs / groupSpan) * 100),
		})
		if (row.type === "message") {
			for (const call of row.toolCalls) {
				const callStart = parseWarehouseTimestamp(call.timestamp)
				if (callStart == null || call.durationMs == null) continue
				segments.push({
					key: `${call.id}-seg`,
					category: call.status === "error" ? "failed" : "tool",
					startPct: ((callStart - model.startMs - groupStart) / groupSpan) * 100,
					widthPct: Math.max(0.8, (call.durationMs / groupSpan) * 100),
				})
			}
		}
	}

	return {
		type: "turnGroup",
		id: `group-${first.id}-${last.id}`,
		offsetMs: groupStart,
		durationMs: groupSpan,
		laneColor: first.laneColor,
		rows: run,
		firstTurn: turns.length > 0 ? Math.min(...turns) : 0,
		lastTurn: turns.length > 0 ? Math.max(...turns) : 0,
		agentNames,
		toolCallCount: run.reduce((sum, row) => sum + (row.type === "message" ? row.toolCalls.length : 0), 0),
		cost: knownCosts.length > 0 ? knownCosts.reduce((sum, cost) => sum + cost, 0) : null,
		segments,
	}
}

// ---------------------------------------------------------------------------
// Predicates shared by the view and the components
// ---------------------------------------------------------------------------

export function rowHasError(row: JourneyRow): boolean {
	if (row.type === "idle") return false
	if (row.type === "turnGroup") return row.rows.some(rowHasError)
	return row.event.status === "error"
}

export function rowHasToolFailure(row: JourneyRow): boolean {
	if (row.type === "turnGroup") return row.rows.some(rowHasToolFailure)
	if (row.type !== "message") return false
	return row.toolCalls.some((call) => call.status === "error")
}

export function isHandoffRow(row: JourneyRow): boolean {
	if (row.type === "turnGroup") return row.rows.some(isHandoffRow)
	if (row.type !== "structural") return false
	return row.event.kind === "agentHandoff" || isInvokeAgent(row.event)
}

export function isInvokeAgent(event: JourneyEventData): boolean {
	return event.operation === "invoke_agent" || event.operation === "create_agent"
}

/** Does this event's body exist at all? `absent` and `events` both render redacted. */
export function hasContent(event: JourneyEventData): boolean {
	return event.content != null && event.content.length > 0 && event.contentSource === "attributes"
}

export function rowCategory(row: JourneyRow): JourneySpanCategory {
	if (row.type === "idle") return "idle"
	if (rowHasError(row)) return "failed"
	if (row.type === "turnGroup") return "model"
	if (row.type === "message") return "model"
	return "tool"
}

// ---------------------------------------------------------------------------
// Aggregate builders
// ---------------------------------------------------------------------------

function earliestTimestamp(events: ReadonlyArray<JourneyEventData>): number | null {
	for (const event of events) {
		const ms = parseWarehouseTimestamp(event.timestamp)
		if (ms != null) return ms
	}
	return null
}

function latestTimestamp(events: ReadonlyArray<JourneyEventData>, fallback: number): number {
	let latest = fallback
	for (const event of events) {
		const ms = parseWarehouseTimestamp(event.timestamp)
		if (ms == null) continue
		latest = Math.max(latest, ms + (event.durationMs ?? 0))
	}
	return latest
}

/**
 * One agent turn — an assistant-side message. This is the unit the warehouse
 * summary, the overview row, the header and the rail's per-agent/per-model
 * tallies all count, so every one of them goes through this predicate rather
 * than counting "messages" and disagreeing with each other. `role` is optional
 * in the GenAI conventions, so a role-less message counts when it carries a
 * model: that is what an assistant reply looks like on the wire.
 */
function isAgentTurn(event: JourneyEventData): boolean {
	if (event.kind !== "message") return false
	if (event.role != null) return event.role === "assistant"
	return (event.model ?? event.requestedModel) != null
}

/** Only used when the warehouse summary is absent. */
function countAgentTurns(events: ReadonlyArray<JourneyEventData>): number {
	return events.filter(isAgentTurn).length
}

function buildAgentStats(events: ReadonlyArray<JourneyEventData>): ReadonlyArray<JourneyAgentStat> {
	const byAgent = new Map<string, { turns: number; cost: number | null; tokens: number }>()
	for (const event of events) {
		const name = event.agentName
		if (!name) continue
		const entry = byAgent.get(name) ?? { turns: 0, cost: null, tokens: 0 }
		if (isAgentTurn(event)) entry.turns += 1
		if (event.cost != null) entry.cost = (entry.cost ?? 0) + event.cost
		entry.tokens += (event.inputTokens ?? 0) + (event.outputTokens ?? 0)
		byAgent.set(name, entry)
	}
	return Array.from(byAgent, ([name, entry]) => ({
		name,
		color: agentColor(name),
		turns: entry.turns,
		cost: entry.cost,
		tokens: entry.tokens,
	})).sort((a, b) => b.turns - a.turns || a.name.localeCompare(b.name))
}

function buildModelStats(events: ReadonlyArray<JourneyEventData>): ReadonlyArray<JourneyModelStat> {
	const byModel = new Map<string, { turns: number; cost: number | null }>()
	for (const event of events) {
		const name = event.model ?? event.requestedModel
		if (!name || !isAgentTurn(event)) continue
		const entry = byModel.get(name) ?? { turns: 0, cost: null }
		entry.turns += 1
		if (event.cost != null) entry.cost = (entry.cost ?? 0) + event.cost
		byModel.set(name, entry)
	}
	return Array.from(byModel, ([name, entry]) => ({ name, turns: entry.turns, cost: entry.cost })).sort(
		(a, b) => b.turns - a.turns || a.name.localeCompare(b.name),
	)
}

/**
 * The "where the time went" band. Segments are positioned absolutely rather
 * than laid out as flex weights, because parallel tool calls overlap in time —
 * three calls fired at once must read as three calls in the same slot, not as
 * three sequential thirds. Idle is the *absence* of a segment, so it needs no
 * geometry: the track's own background is the idle colour.
 */
function buildSegments(
	events: ReadonlyArray<JourneyEventData>,
	startMs: number,
	totalMs: number,
): ReadonlyArray<JourneyTimeSegment> {
	const segments: Array<JourneyTimeSegment> = []
	for (const event of events) {
		if (event.kind === "systemPrompt") continue
		const eventStart = parseWarehouseTimestamp(event.timestamp)
		if (eventStart == null || event.durationMs == null || event.durationMs <= 0) continue
		const category: JourneySpanCategory =
			event.status === "error" ? "failed" : event.kind === "toolCall" ? "tool" : "model"
		segments.push({
			key: event.id,
			category,
			startPct: Math.min(100, Math.max(0, ((eventStart - startMs) / totalMs) * 100)),
			widthPct: Math.max(0.4, Math.min(100, (event.durationMs / totalMs) * 100)),
		})
	}
	return segments
}

function buildTimeTotals(
	segments: ReadonlyArray<JourneyTimeSegment>,
	totalMs: number,
): Record<JourneySpanCategory, number> {
	// Sum the *union* per category, not the raw durations: two tool calls run in
	// parallel occupy one stretch of the clock, and adding them would report more
	// tool time than the journey has wall clock.
	const totals: Record<JourneySpanCategory, number> = { model: 0, tool: 0, failed: 0, idle: 0 }
	let busy = 0
	for (const category of ["model", "tool", "failed"] as const) {
		const intervals = segments
			.filter((segment) => segment.category === category)
			.map((segment) => [segment.startPct, segment.startPct + segment.widthPct] as const)
			.sort((a, b) => a[0] - b[0])
		let coveredPct = 0
		let cursor = -1
		for (const [from, to] of intervals) {
			const start = Math.max(from, cursor)
			if (to > start) {
				coveredPct += to - start
				cursor = to
			}
		}
		totals[category] = (coveredPct / 100) * totalMs
		busy += totals[category]
	}
	totals.idle = Math.max(0, totalMs - busy)
	return totals
}

function buildTokenBreakdown(
	summary: JourneySummaryData | null,
	events: ReadonlyArray<JourneyEventData>,
): JourneyTokenBreakdown {
	const inputTokens = summary?.inputTokens ?? sum(events, (event) => event.inputTokens)
	const outputTokens = summary?.outputTokens ?? sum(events, (event) => event.outputTokens)
	const cachedInput = Math.min(
		inputTokens,
		summary?.cachedInputTokens ?? sum(events, (e) => e.cachedInputTokens),
	)
	// Reasoning tokens are a subset of output in the GenAI conventions, but some
	// providers report them alongside the output count instead of inside it.
	// Clamping such a figure into `outputTokens` used to leave reasoning ==
	// output and "output · visible 0" on a journey whose prose is right there on
	// screen. When the number can't be a subset the split simply isn't
	// derivable — attribute output to visible and drop the reasoning row; the
	// per-turn `reasoning N` badges still carry the signal.
	const reportedReasoning = summary?.reasoningTokens ?? sum(events, (e) => e.reasoningTokens)
	const reasoning = reportedReasoning < outputTokens ? reportedReasoning : 0
	return {
		cachedInput,
		freshInput: Math.max(0, inputTokens - cachedInput),
		reasoning,
		visibleOutput: Math.max(0, outputTokens - reasoning),
		total: summary?.totalTokens ?? inputTokens + outputTokens,
		cachedShare: inputTokens > 0 ? cachedInput / inputTokens : null,
	}
}

function sum(
	events: ReadonlyArray<JourneyEventData>,
	pick: (event: JourneyEventData) => number | null,
): number {
	return events.reduce((total, event) => total + (pick(event) ?? 0), 0)
}

function idleReason(next: JourneyEventData): string {
	if (next.kind === "message" && next.role === "user") return "waiting on the user"
	if (next.status === "error") return "before a retry"
	return "no recorded activity"
}

/**
 * The structural bar's label. Unknown operations fall through to their own
 * name, uppercased — that is the whole point of the archetype: a `retrieval`
 * we've never rendered still reads as a retrieval, not as a blank row.
 */
function structuralLabel(event: JourneyEventData): string {
	if (event.kind === "agentHandoff") return "HANDOFF"
	switch (event.operation) {
		case "invoke_agent":
			return "INVOKE AGENT"
		case "create_agent":
			return "CREATE AGENT"
		case "execute_tool":
			return "TOOL"
		case "embeddings":
			return "EMBEDDINGS"
		default:
			break
	}
	const normalised = event.operation.replace(/[._]/g, " · ").toUpperCase()
	return normalised.length > 0 ? normalised : (event.spanName || "EVENT").toUpperCase()
}
