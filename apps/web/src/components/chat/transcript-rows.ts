import { parseDiagnosisMarker } from "./diagnosis-marker"
import type { UIMessage } from "@/components/ai-elements/types"

export type ToolPart = {
	type: string
	toolCallId: string
	toolName?: string
	state: string
	input?: unknown
	output?: unknown
	errorText?: string
}

export function isToolPart(part: UIMessage["parts"][number]): boolean {
	return part.type.startsWith("tool-") || part.type === "dynamic-tool"
}

export function toolNameFor(part: ToolPart): string {
	if (part.type.startsWith("tool-")) return part.type.replace(/^tool-/, "")
	return part.toolName ?? "unknown"
}

export function deriveToolStatus(state: string): "running" | "completed" | "error" {
	if (state === "output-available") return "completed"
	if (state === "output-error" || state === "output-denied") return "error"
	return "running"
}

/**
 * A tool part that renders as its own card — a diagnosis report or an approval
 * prompt — rather than as a line in a tool group. These are content, not plumbing,
 * so they never disappear into a `Used N tools` header.
 */
function rendersOwnCard(part: ToolPart): boolean {
	// A proposal has no output to inspect — the tool never ran — so the state IS the signal.
	if (part.state === "proposed") return true
	if (part.state !== "output-available") return false
	return parseDiagnosisMarker(part.output) != null
}

/**
 * An assistant turn that is nothing but plumbing: one lap of the agent loop, all
 * tool calls, no prose and no card-worthy output. Runs of these are what the
 * transcript merges.
 */
export function isToolOnlyMessage(message: UIMessage): boolean {
	if (message.role !== "assistant") return false
	if (message.parts.length === 0) return false
	return message.parts.every((part) => isToolPart(part) && !rendersOwnCard(part as ToolPart))
}

export type TranscriptRow =
	| { kind: "message"; id: string; message: UIMessage }
	/** Two or more adjacent tool-only turns, drawn as a single tool group. */
	| { kind: "tool-run"; id: string; messages: readonly UIMessage[] }

/**
 * Messages → transcript rows, merging each maximal run of **two or more** adjacent
 * tool-only assistant turns into one row. An agent loop emits one message per
 * round-trip, so without this a twelve-call run reads as six identical
 * `Used 2 tools` cards stacked down the page.
 *
 * A run of one stays an ordinary message row — the single-call case is unchanged.
 * Anything that isn't a tool-only turn (a user turn, prose, a diagnosis or approval
 * card) breaks the run, which is the right boundary: text between two bursts of
 * tool calls is a real beat in the conversation.
 *
 * A merged row is addressed by its first message's id. The rest of the run is no
 * longer registered with the scroller, so a `?m=` permalink into the middle of a
 * tool burst no longer resolves — the scroller queues the jump and never flushes it.
 */
export function buildTranscriptRows(messages: readonly UIMessage[]): TranscriptRow[] {
	const rows: TranscriptRow[] = []

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]!
		if (!isToolOnlyMessage(message)) {
			rows.push({ kind: "message", id: message.id, message })
			continue
		}

		let end = i + 1
		while (end < messages.length && isToolOnlyMessage(messages[end]!)) end++

		if (end - i === 1) {
			rows.push({ kind: "message", id: message.id, message })
		} else {
			rows.push({ kind: "tool-run", id: message.id, messages: messages.slice(i, end) })
		}
		i = end - 1
	}

	return rows
}

/** Every tool part in a merged run, in order, flattened into one buffer. */
export function toolPartsOf(row: Extract<TranscriptRow, { kind: "tool-run" }>): ToolPart[] {
	return row.messages.flatMap((message) => message.parts.filter(isToolPart) as ToolPart[])
}
