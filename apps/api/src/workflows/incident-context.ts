/**
 * The incident, rendered for a model rather than for a parser.
 *
 * Every investigation surface used to hand the agent `JSON.stringify({ subject,
 * snapshot })` and nothing else. That is not a neutral choice: the two facts the
 * prompts open by demanding — "establish the exact incident interval" and "call
 * `error_detail` with the fingerprint" — were buried among a dozen sibling keys,
 * in a blob whose most prominent fields are the display `facts` array. The model
 * routinely skipped both, then reported that it could not scope the query.
 *
 * So the interval and the identifiers get their own headed sections, and the
 * fingerprint is printed under the exact parameter name the tool takes. The raw
 * JSON stays, last, because it is a complete record and something eventually
 * wants a field this renderer does not know about.
 *
 * One builder for all three call sites — the single-pass kickoff, the planner,
 * and every hypothesis lane — because a lane that saw a different framing of the
 * same incident than the planner did is a very expensive way to disagree.
 */
import type { InvestigationSubject, InvestigationSubjectSnapshot } from "@maple/domain/http"

/**
 * The instruction on a single-pass investigation's opening turn.
 *
 * Shared so the manual and automatic starts cannot drift: they used to carry two
 * copies of the same paragraph, and a wording change to one was a silent A/B
 * test nobody was reading.
 */
export const AUTONOMOUS_KICKOFF_LEAD =
	"Begin the autonomous investigation now. Gather evidence with tools, then call " +
	"submit_diagnosis exactly once."

const line = (label: string, value: string | number | null | undefined): string | null =>
	value === null || value === undefined || value === "" ? null : `- ${label}: ${value}`

/**
 * Whether an interval is worth printing as an instruction.
 *
 * A one-sided window is still useful — "started at X, still open" is a real
 * scope — so only a fully-empty pair falls through to the caveat.
 */
const intervalSection = (snapshot: InvestigationSubjectSnapshot | null): string => {
	const start = snapshot?.incidentStartedAt ?? null
	const end = snapshot?.incidentEndedAt ?? null
	if (start === null && end === null) {
		return [
			"## Interval",
			"",
			"NOT KNOWN. Establish it yourself before querying anything else — pick a window from the",
			"incident's own telemetry rather than accepting a tool's default \"recent\" range, and say in",
			"your report which window you settled on.",
		].join("\n")
	}
	return [
		"## Interval",
		"",
		"Scope every query to this window. Pass it explicitly — do not rely on a tool's default range.",
		"",
		...[line("start", start), line("end", end ?? "still open")].filter((entry) => entry !== null),
	].join("\n")
}

const identifierSection = (snapshot: InvestigationSubjectSnapshot | null): string | null => {
	const fingerprint = snapshot?.fingerprintHash ?? null
	const entries = [
		// Printed under the tool's own parameter name, not the column's. `error_detail`
		// takes `fingerprint`, and a model reading `fingerprintHash` has to guess that
		// they are the same thing.
		line("fingerprint (pass as `fingerprint` to error_detail)", fingerprint),
		line("service", snapshot?.serviceName ?? snapshot?.scope ?? null),
		line("environment", snapshot?.deploymentEnv ?? null),
		line("exception type", snapshot?.exceptionType ?? null),
		line("exception message", snapshot?.exceptionMessage ?? null),
		line("top frame", snapshot?.topFrame ?? null),
		line("error label", snapshot?.errorLabel ?? null),
		line("occurrences", snapshot?.occurrenceCount ?? null),
		line("signal", snapshot?.signalType ?? null),
		line("observed value", snapshot?.observedValue ?? null),
		line("threshold", snapshot?.thresholdValue ?? null),
	].filter((entry) => entry !== null)
	if (entries.length === 0) return null
	return ["## Identifiers", "", "Use these verbatim. Never invent one.", "", ...entries].join("\n")
}

/**
 * @param lead The instruction this context is attached to — what to do with it.
 */
export const buildIncidentContextMessage = (
	lead: string,
	subject: InvestigationSubject,
	snapshot: InvestigationSubjectSnapshot | null,
): string =>
	[
		lead,
		`## Subject\n\n${snapshot?.title ?? "(untitled)"}${
			snapshot?.severity ? `\n\nSeverity: ${snapshot.severity}` : ""
		}`,
		intervalSection(snapshot),
		identifierSection(snapshot),
		// Last, and labelled as the fallback it is. Everything above is a projection
		// of this; nothing above is a substitute for it.
		`## Raw subject\n\nComplete record, for anything the sections above omit.\n\n\`\`\`json\n${JSON.stringify(
			{ subject, snapshot },
			null,
			2,
		)}\n\`\`\``,
	]
		.filter((section) => section !== null)
		.join("\n\n")
