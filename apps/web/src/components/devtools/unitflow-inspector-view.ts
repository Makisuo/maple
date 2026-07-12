/**
 * Pure transforms over the unitflow debug inspector's output, kept out of the
 * React component so they can be reasoned about (and unit-tested) on their own.
 * The inspector itself lives in `@maple/unitflow` (`Debug.attach`) and is
 * attached to the shared runtime in `@/lib/models/runtime` (dev only).
 */

import type { Debug } from "@maple/unitflow"

export type DebugEvent = Debug.DebugEvent
export type Snapshot = Debug.Snapshot

/** A causal transaction: a root publication (an event with no live cause) and
 * the events dispatched inside its synchronous fan-out, each with its depth. */
export interface CausalGroup {
	readonly root: number
	readonly items: ReadonlyArray<{ readonly event: DebugEvent; readonly depth: number }>
}

const MAX_DEPTH = 16

/** Walk `cause` pointers to the topmost ancestor still present in the buffer (a
 * cause evicted from the ring is treated as a root). Cycle- and depth-guarded. */
const climb = (event: DebugEvent, bySeq: Map<number, DebugEvent>): { readonly root: number; readonly depth: number } => {
	let current = event
	let depth = 0
	const seen = new Set<number>([current.seq])
	while (current.cause !== undefined && depth < MAX_DEPTH) {
		const parent = bySeq.get(current.cause)
		if (parent === undefined || seen.has(parent.seq)) break
		seen.add(parent.seq)
		current = parent
		depth += 1
	}
	return { root: current.seq, depth }
}

/**
 * Groups the most recent `limit` events into causal transactions: each group is
 * one root publication and the writes/emits its synchronous dispatch caused,
 * indented by depth. Groups are ordered newest-root-first; within a group,
 * events keep seq order. This is the "what caused what" view.
 */
export const buildCausalGroups = (events: ReadonlyArray<DebugEvent>, limit: number): ReadonlyArray<CausalGroup> => {
	const bySeq = new Map(events.map((event) => [event.seq, event]))
	const recent = events.slice(Math.max(0, events.length - limit))
	const groups = new Map<number, { root: number; items: Array<{ event: DebugEvent; depth: number }> }>()
	for (const event of recent) {
		const { root, depth } = climb(event, bySeq)
		let group = groups.get(root)
		if (group === undefined) {
			group = { root, items: [] }
			groups.set(root, group)
		}
		group.items.push({ event, depth })
	}
	return [...groups.values()].sort((a, b) => b.root - a.root)
}

/** Newest-first flat list of events whose name/type matches `query`
 * (case-insensitive substring). Used when a filter is active. */
export const filterEvents = (
	events: ReadonlyArray<DebugEvent>,
	query: string,
	limit: number,
): ReadonlyArray<DebugEvent> => {
	const needle = query.trim().toLowerCase()
	const matched =
		needle === ""
			? events
			: events.filter(
					(event) => event.name.toLowerCase().includes(needle) || event.type.toLowerCase().includes(needle),
				)
	return matched.slice(Math.max(0, matched.length - limit)).reverse()
}

/**
 * JSON-ish stringify that survives the values flowing through unitflow
 * stores/events: Maps, Sets, functions, bigints, and cycles. `space` 0 yields a
 * compact one-liner (for row previews), 2 an indented block (for the expander).
 */
export const safeStringify = (value: unknown, space = 2): string => {
	const seen = new WeakSet<object>()
	const replacer = (_key: string, val: unknown): unknown => {
		if (typeof val === "bigint") return `${val.toString()}n`
		if (typeof val === "function") return `[Function ${val.name || "anonymous"}]`
		if (val instanceof Map) return { "[Map]": Object.fromEntries([...val.entries()].slice(0, 50)) }
		if (val instanceof Set) return { "[Set]": [...val.values()].slice(0, 50) }
		if (typeof val === "object" && val !== null) {
			if (seen.has(val)) return "[Circular]"
			seen.add(val)
		}
		return val
	}
	try {
		const out = JSON.stringify(value, replacer, space)
		return out === undefined ? String(value) : out
	} catch {
		return String(value)
	}
}

/** A compact one-line preview of a value for a row. */
export const previewValue = (value: unknown): string => {
	if (value === undefined) return "—"
	const text = safeStringify(value, 0)
	return text.length > 120 ? `${text.slice(0, 117)}…` : text
}

export type EventTypeVariant = "info" | "success" | "secondary" | "warning"

/** Badge styling + label per event type. */
export const eventTypeMeta = (type: DebugEvent["type"]): { readonly label: string; readonly variant: EventTypeVariant } => {
	switch (type) {
		case "emit":
			return { label: "emit", variant: "info" }
		case "write":
			return { label: "write", variant: "success" }
		case "instance-created":
			return { label: "created", variant: "secondary" }
		case "instance-disposed":
			return { label: "disposed", variant: "warning" }
	}
}

/** Render an instance key (primitive or record) compactly. */
export const formatInstanceKey = (key: unknown): string =>
	key === undefined ? "" : typeof key === "string" ? key : safeStringify(key, 0)
