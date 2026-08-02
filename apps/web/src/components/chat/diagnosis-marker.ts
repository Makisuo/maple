import { AiTriageResult } from "@maple/domain/http"
import { Option, Schema } from "effect"

/**
 * Investigate-mode emits the structured report through the local `submit_diagnosis`
 * tool, whose output is this marker (NOT a proposal — it has already been
 * persisted server-side). The web renders it as the inline report card. Mirrors
 * the shape the `submit_diagnosis` tool returns in `apps/api/src/chat/agent.ts`.
 */
export interface DiagnosisMarker {
	status: "diagnosis"
	report: AiTriageResult
}

const decodeReport = Schema.decodeUnknownOption(AiTriageResult)

/** Parse a `submit_diagnosis` tool output into a {@link DiagnosisMarker}, or `null`. */
export const parseDiagnosisMarker = (output: unknown): DiagnosisMarker | null => {
	let value: unknown = output
	if (typeof output === "string") {
		try {
			value = JSON.parse(output)
		} catch {
			return null
		}
	}
	if (!value || typeof value !== "object") return null
	const v = value as Record<string, unknown>
	if (v.status !== "diagnosis") return null
	return Option.match(decodeReport(v.report), {
		onNone: () => null,
		onSome: (report) => ({ status: "diagnosis", report }),
	})
}
