// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
/**
 * Turns an `HttpApiSchemaError` (the framework's request-decode failure) into
 * human-readable, path-anchored lines.
 *
 * The runtime's own response for a decode failure is an empty 400 — no field,
 * no value, no message — which leaves callers bisecting their payload widget by
 * widget to find the one bad key. Every route that can reject a hand-authored
 * document should render the issue tree instead.
 *
 * Each line reads `<json path> (widget "<id>"): Expected …, got …`, with the
 * widget attribution present only when the path actually points inside a
 * `widgets[]` array — resolved from the offending value itself, so it survives
 * reordering and is stable across the v1/v2 key spellings.
 */
import { SchemaIssue } from "effect"

/** Which part of the request failed to decode; mirrors `HttpApiSchemaError.kind`. */
export type SchemaErrorKind = "Params" | "Headers" | "Query" | "Body" | "Payload" | "ResponseHeaders"

/** Formats a path as `dashboard.widgets[3].display.fillNulls`. */
export const formatIssuePath = (path: ReadonlyArray<PropertyKey>): string => {
	let out = ""
	for (const segment of path) {
		if (typeof segment === "number") {
			out += `[${segment}]`
		} else if (typeof segment === "symbol") {
			out += out === "" ? (segment.description ?? "<symbol>") : `.${segment.description ?? "<symbol>"}`
		} else {
			out += out === "" ? segment : `.${segment}`
		}
	}
	return out
}

const readKey = (value: unknown, key: PropertyKey): unknown => {
	if (typeof value !== "object" || value === null) return undefined
	if (typeof key === "number") return Array.isArray(value) ? value[key] : undefined
	return (value as Record<PropertyKey, unknown>)[key]
}

/**
 * Resolves the `id` of the widget an issue path points into, by walking the
 * decoded-from input down to the `widgets[i]` element. Returns undefined when
 * the path is not inside a widget array or the element carries no string id
 * (e.g. the id itself is the invalid field).
 */
export const widgetIdForPath = (root: unknown, path: ReadonlyArray<PropertyKey>): string | undefined => {
	let cursor = root
	let widgetId: string | undefined
	for (let i = 0; i < path.length; i++) {
		const segment = path[i]!
		const next = readKey(cursor, segment)
		if (segment === "widgets" && typeof path[i + 1] === "number") {
			const widget = readKey(next, path[i + 1]!)
			const id = readKey(widget, "id")
			if (typeof id === "string") widgetId = id
		}
		cursor = next
	}
	return widgetId
}

const formatStandard = SchemaIssue.makeFormatterStandardSchemaV1()

const reportedInputs = (issue: SchemaIssue.Issue): ReadonlyArray<unknown> => {
	const inputs: Array<unknown> = []
	const visit = (current: SchemaIssue.Issue) => {
		if (SchemaIssue.hasInput(current)) inputs.push(current.input)
		switch (current._tag) {
			case "Filter":
			case "Encoding":
			case "Pointer":
				visit(current.issue)
				break
			case "Composite":
			case "AnyOf":
				current.issues.forEach(visit)
				break
		}
	}
	visit(issue)
	return inputs
}

export interface SchemaIssueDetail {
	/** Dotted/bracketed JSON path of the offending value, `""` at the root. */
	readonly path: string
	/** `id` of the enclosing widget, when the path points inside `widgets[]`. */
	readonly widgetId: string | undefined
	/** Expected-vs-received message(s) for this path, joined with `; `. */
	readonly message: string
	/** `path (widget "id"): message` — the string surfaced to API callers. */
	readonly line: string
}

/** Hard cap so a wholesale-malformed document can't produce a megabyte of 400. */
const MAX_DETAILS = 20

/**
 * Flattens a decode failure into one entry per offending path. Issues sharing a
 * path (union branches, most commonly) are merged so a two-branch union reads as
 * one problem rather than two.
 */
export const describeSchemaIssue = (issue: SchemaIssue.Issue): ReadonlyArray<SchemaIssueDetail> => {
	// JSON-body decoding may wrap the decoded object in an outer issue whose
	// reported input is the raw request string. Keep every reported input so the
	// decoded root object can still resolve an enclosing widget id.
	const inputs = reportedInputs(issue)
	const byPath = new Map<string, { path: ReadonlyArray<PropertyKey>; messages: Array<string> }>()

	for (const entry of formatStandard(issue).issues) {
		// Standard Schema allows either a bare key or a `{ key }` segment object.
		const path = (entry.path ?? []).map((segment) =>
			typeof segment === "object" && segment !== null ? segment.key : segment,
		)
		const key = formatIssuePath(path)
		const existing = byPath.get(key)
		if (existing === undefined) {
			byPath.set(key, { path, messages: [entry.message] })
		} else if (!existing.messages.includes(entry.message)) {
			existing.messages.push(entry.message)
		}
	}

	const details: Array<SchemaIssueDetail> = []
	for (const [key, { path, messages }] of byPath) {
		const widgetId = inputs.map((input) => widgetIdForPath(input, path)).find((id) => id !== undefined)
		const message = messages.join("; ")
		const location = key === "" ? "<root>" : key
		const label = widgetId === undefined ? location : `${location} (widget "${widgetId}")`
		details.push({ path: key, widgetId, message, line: `${label}: ${message}` })
		if (details.length === MAX_DETAILS) break
	}
	return details
}

const KIND_LABEL: Record<SchemaErrorKind, string> = {
	Params: "path parameters",
	Headers: "headers",
	Query: "query string",
	Body: "body",
	Payload: "payload",
	ResponseHeaders: "response headers",
} satisfies Record<SchemaErrorKind, string>

/** `Request payload is invalid (2 problems).` — the summary line for the 400. */
export const summarizeSchemaError = (
	kind: SchemaErrorKind,
	details: ReadonlyArray<SchemaIssueDetail>,
): string => {
	const label = KIND_LABEL[kind]
	if (details.length === 0) return `Request ${label} is invalid.`
	const count = details.length === 1 ? "1 problem" : `${details.length} problems`
	return `Request ${label} is invalid (${count}).`
}
