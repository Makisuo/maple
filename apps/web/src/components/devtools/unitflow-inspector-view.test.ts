import { describe, expect, it } from "vitest"
import {
	buildCausalGroups,
	type DebugEvent,
	filterEvents,
	previewValue,
	safeStringify,
} from "./unitflow-inspector-view"

const ev = (seq: number, opts: Partial<DebugEvent> = {}): DebugEvent => ({
	seq,
	time: seq,
	type: "emit",
	name: `e${seq}`,
	id: `id${seq}`,
	...opts,
})

describe("buildCausalGroups", () => {
	it("nests events under their root cause, indented by depth", () => {
		const events: DebugEvent[] = [
			ev(1, { type: "emit", name: "toggle" }),
			ev(2, { type: "write", name: "state", cause: 1 }),
			ev(3, { type: "write", name: "derived", cause: 2 }),
		]
		const [group] = buildCausalGroups(events, 100)
		expect(group?.root).toBe(1)
		expect(group?.items.map((item) => [item.event.name, item.depth])).toEqual([
			["toggle", 0],
			["state", 1],
			["derived", 2],
		])
	})

	it("orders groups newest-root-first and keeps separate transactions apart", () => {
		const events: DebugEvent[] = [
			ev(1, { name: "a" }),
			ev(2, { name: "a-child", cause: 1 }),
			ev(3, { name: "b" }),
		]
		const groups = buildCausalGroups(events, 100)
		expect(groups.map((group) => group.root)).toEqual([3, 1])
	})

	it("treats an evicted cause (not in the buffer) as a root", () => {
		// The parent (#1) has scrolled out of the ring; #2 still references it.
		const events: DebugEvent[] = [ev(2, { name: "orphan", cause: 1 })]
		const [group] = buildCausalGroups(events, 100)
		expect(group?.root).toBe(2)
		expect(group?.items[0]?.depth).toBe(0)
	})
})

describe("filterEvents", () => {
	const events: DebugEvent[] = [
		ev(1, { type: "emit", name: "toggleRule" }),
		ev(2, { type: "write", name: "overview" }),
		ev(3, { type: "emit", name: "refresh" }),
	]

	it("matches by name substring, newest-first", () => {
		expect(filterEvents(events, "toggle", 100).map((e) => e.seq)).toEqual([1])
	})

	it("matches by event type", () => {
		expect(filterEvents(events, "emit", 100).map((e) => e.seq)).toEqual([3, 1])
	})

	it("returns all (newest-first) for an empty query", () => {
		expect(filterEvents(events, "  ", 100).map((e) => e.seq)).toEqual([3, 2, 1])
	})
})

describe("safeStringify / previewValue", () => {
	it("renders Maps, Sets, bigints and functions instead of throwing or dropping them", () => {
		const value = {
			count: 2n,
			byId: new Map([["a", 1]]),
			tags: new Set(["x"]),
			fn: function handler() {},
		}
		const text = safeStringify(value, 0)
		expect(text).toContain("2n")
		expect(text).toContain("[Map]")
		expect(text).toContain("[Set]")
		expect(text).toContain("[Function handler]")
	})

	it("survives circular references", () => {
		const a: Record<string, unknown> = {}
		a.self = a
		expect(safeStringify(a, 0)).toContain("[Circular]")
	})

	it("previewValue shows an em dash for undefined and truncates long values", () => {
		expect(previewValue(undefined)).toBe("—")
		const long = previewValue({ text: "x".repeat(400) })
		expect(long.endsWith("…")).toBe(true)
		expect(long.length).toBeLessThanOrEqual(120)
	})
})
