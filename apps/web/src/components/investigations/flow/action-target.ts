/**
 * What a proposed action *is*, and where it is carried out.
 *
 * The API returns prose, not structured actions, so both are inferred from the
 * verb. The two are deliberately separate answers: an action can have a
 * recognisable kind and still have nowhere in Maple to perform it — "roll back
 * deploy 8f21c" is unmistakably a rollback, and there is no deploys page to send
 * anyone to. Classifying and routing together would have meant that row losing
 * its icon as well as its link.
 *
 * Routing stays conservative — the wrong link is worse than none, so an
 * unrecognised verb gets `target: null` and the node renders no call to action
 * rather than a dead one.
 */
import type { V2Investigation } from "@maple/domain/http/v2"

/**
 * The shape of work an action asks for. `task` is the honest fallback: it says
 * "something to do" without claiming to know what, and it keeps the icon lane
 * occupied on every row so the column still reads as a column.
 */
export type ActionKind =
	| "rollback"
	| "alert"
	| "dashboard"
	| "traces"
	| "logs"
	| "issue"
	| "config"
	| "code"
	| "service"
	| "task"

export interface ActionTarget {
	/** Uppercase CTA text, e.g. `CREATE ALERT`. */
	readonly label: string
	/** An app-relative path — always internal, never a bare external URL. */
	readonly href: string
}

export interface ActionClassification {
	readonly kind: ActionKind
	readonly target: ActionTarget | null
}

/**
 * Word stems, matched with a trailing inflection so "span" also catches "spans"
 * and "deploy" catches "deployed" — the report writes prose, and half its verbs
 * arrive plural or past-tense. The leading `\b` is what keeps this from matching
 * inside a longer word: "catalogue" is not a logs action.
 */
const inflected = (stems: ReadonlyArray<string>): RegExp =>
	new RegExp(`\\b(?:${stems.join("|")})(?:s|es|d|ed|ing)?\\b`)

/**
 * Ordered most-specific first, and the order is load-bearing: "roll back the
 * deploy and alert on pool saturation" is a rollback that mentions an alert, not
 * an alert. Every pattern is matched against the lowercased sentence.
 */
const KINDS: ReadonlyArray<{ kind: ActionKind; match: RegExp }> = [
	{
		kind: "rollback",
		match: inflected(["roll ?back", "revert", "redeploy", "deploy", "ship", "release", "hotfix"]),
	},
	{ kind: "alert", match: inflected(["alert", "monitor", "threshold", "page", "notify"]) },
	{ kind: "dashboard", match: inflected(["dashboard", "chart", "graph", "panel"]) },
	// Above traces on purpose: "check telemetry ingestion … whether root spans are
	// emitted" is an instrumentation job that happens to say "spans". The bare word
	// "service" is too common to sit this high, so it keeps its own entry below.
	{ kind: "service", match: inflected(["instrument", "telemetry", "exporter", "ingest", "sdk"]) },
	{ kind: "traces", match: inflected(["trace", "span", "latency", "p9\\d", "percentile"]) },
	{ kind: "logs", match: inflected(["log", "stack ?trace"]) },
	{ kind: "issue", match: inflected(["issue", "exception", "error", "fingerprint"]) },
	{
		kind: "config",
		match: inflected([
			"pool",
			"timeout",
			"limit",
			"quota",
			"capacity",
			"scale",
			"raise",
			"lower",
			"increase",
			"config",
			"setting",
			"flag",
			"budget",
		]),
	},
	{
		kind: "code",
		match: inflected(["code", "patch", "fix", "client", "library", "handler", "retry", "circuit"]),
	},
	{ kind: "service", match: inflected(["service", "endpoint", "runtime"]) },
]

export function classifyAction(action: string, investigation: V2Investigation): ActionClassification {
	const text = action.toLowerCase()
	const kind = KINDS.find((entry) => entry.match.test(text))?.kind ?? "task"
	return { kind, target: actionTarget(text, investigation) }
}

/**
 * Routing is matched independently of the kind, and in its own order — a
 * rollback that says "alert on pool_active" still has an alerts page to go to,
 * which is more use than no link at all.
 */
function actionTarget(text: string, investigation: V2Investigation): ActionTarget | null {
	if (text.includes("alert")) return { label: "CREATE ALERT", href: "/alerts" }
	if (text.includes("dashboard")) return { label: "OPEN DASHBOARDS", href: "/dashboards" }
	if (text.includes("trace") || text.includes("span")) return { label: "VIEW TRACES", href: "/traces" }
	if (text.includes("log")) return { label: "SEARCH LOGS", href: "/logs" }

	const scope = investigation.snapshot.serviceName ?? investigation.snapshot.scope
	if (scope && !scope.includes(" ") && (text.includes("service") || text.includes(scope.toLowerCase()))) {
		return { label: "VIEW SERVICE", href: `/services/${encodeURIComponent(scope)}` }
	}

	const issueId = investigation.subject.type === "incident" ? investigation.subject.issue_id : null
	if (issueId && (text.includes("issue") || text.includes("error"))) {
		return { label: "OPEN ISSUE", href: `/errors/issues/${issueId}` }
	}
	return null
}
