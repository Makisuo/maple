/**
 * The authoring tasks used to compare documentation versions.
 *
 * Each one targets a failure mode observed in the shipped tooling, so a task an
 * agent gets right is evidence about that specific mode rather than about
 * general competence.
 */
export interface WidgetEvalTask {
	readonly id: string
	/** Given to the agent verbatim. Says what the user wants, never how to encode it. */
	readonly request: string
	/** The panel the request calls for, checked after decode. */
	readonly expectPanelType?: string
	/** The unit the request calls for. `undefined` means the task does not test units. */
	readonly expectUnit?: string
	/** Which shipped failure mode this probes. Reporting only. */
	readonly probes: string
}

export const TASKS: ReadonlyArray<WidgetEvalTask> = [
	{
		id: "error-rate-line",
		request:
			"A line chart of the error rate for the `api` service over time, broken down by service name. Label the axis as a percentage.",
		expectPanelType: "line",
		// `error_rate` is a 0–1 ratio, so the token that renders it correctly is
		// `percent`. `percent_100` reads healthy and renders 100x low.
		expectUnit: "percent",
		probes: "percent vs percent_100 scale",
	},
	{
		id: "latency-stat",
		request: "A single big number showing p95 latency across all services for the current window.",
		expectPanelType: "stat",
		expectUnit: "duration_ms",
		probes: "scalar reduceToValue; p95_duration vs bare p95",
	},
	{
		id: "top-operations-bar",
		request: "A vertical bar chart of request volume over time, split by span name. Not a line — bars.",
		// The case that was previously unreachable on the structured path: nothing
		// derived `chartId`, so you had to hand-write "query-builder-bar".
		expectPanelType: "bar",
		probes: "bar reachable at all",
	},
	{
		id: "top-services-hbar",
		request:
			"A ranked 'top 10 services by request volume' panel. Each row should show its share of the total.",
		// `hbar`, not `funnel` — a funnel labels each bar as a share of the largest
		// and implies sequential stages.
		expectPanelType: "hbar",
		probes: "hbar vs funnel; breakdown requires groupBy",
	},
	{
		id: "note",
		request:
			"A note pinned to the dashboard with the text: 'Owned by the platform team. Escalate in #platform-oncall.'",
		expectPanelType: "markdown",
		probes: "static data source vs the retired markdown_static endpoint",
	},
	{
		id: "cpu-gauge",
		request:
			"A gauge showing the `system.cpu.utilization` gauge metric, which this exporter reports as a 0-100 percentage.",
		expectPanelType: "gauge",
		// Reported 0–100, so `percent_100`. Also needs the arc set to match.
		expectUnit: "percent_100",
		probes: "percent direction on an already-scaled metric; gauge min/max",
	},
]
