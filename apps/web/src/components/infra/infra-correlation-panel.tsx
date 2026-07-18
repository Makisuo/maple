import { addMinutes, subMinutes } from "date-fns"
import { Link } from "@tanstack/react-router"

import { ExternalLinkIcon } from "@/components/icons"
import { formatForTinybird, relativeToAbsolute } from "@/lib/time-utils"
import { normalizeTimestampInput } from "@/lib/timezone-format"

import { NodeDetailChart, PodDetailChart } from "./k8s-detail-chart"
import { HostDetailChart } from "./host-detail-chart"
import { getActiveInfraCorrelations, type InfraCorrelation } from "./infra-correlations"
import { useLinkedCursor } from "@/hooks/use-linked-cursor"

const DEFAULT_PAD_MINUTES = 15
// Charts bucket at this width; metrics are sampled coarsely (hostmetrics /
// kubeletstats intervals), so a single span/log needs a padded window to have
// any points to draw.
const BUCKET_SECONDS = 60

/**
 * Builds a padded `[startTime, endTime]` window (in warehouse datetime format)
 * centred on a span/log anchor. For a span, pass its `durationMs` so the
 * window also covers the span's full extent. Falls back to a recent window if
 * the anchor can't be parsed.
 */
export function infraCorrelationWindow(
	anchor: string,
	opts?: { spanDurationMs?: number; padMinutes?: number },
): { startTime: string; endTime: string } {
	const date = new Date(normalizeTimestampInput(anchor))
	if (Number.isNaN(date.getTime())) {
		return relativeToAbsolute("30m")!
	}
	const pad = opts?.padMinutes ?? DEFAULT_PAD_MINUTES
	const end = addMinutes(new Date(date.getTime() + (opts?.spanDurationMs ?? 0)), pad)
	return {
		startTime: formatForTinybird(subMinutes(date, pad)),
		endTime: formatForTinybird(end),
	}
}

interface InfraCorrelationPanelProps {
	resourceAttributes: Record<string, string> | null | undefined
	startTime: string
	endTime: string
}

/**
 * Renders the live pod/node/host metrics for whichever infra identity the
 * opened span/log carries, plus a deep-link into the full infra detail page.
 * Maple's analogue of HyperDX's `DBInfraPanel`. Chart components self-fetch and
 * own their loading/error/empty states, so this stays thin.
 */
export function InfraCorrelationPanel({
	resourceAttributes,
	startTime,
	endTime,
}: InfraCorrelationPanelProps) {
	const correlations = getActiveInfraCorrelations(resourceAttributes)
	// One linked hover cursor across every chart in the panel (charts stay
	// independent — no Recharts syncId render storms).
	const { containerProps } = useLinkedCursor(true)

	if (correlations.length === 0) {
		return (
			<div className="rounded-md border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
				No Kubernetes or host metadata on this record.
			</div>
		)
	}

	// One shared syncId across every chart so the linked cursor tracks together.
	const syncId = "infra-correlation"

	return (
		<div className="space-y-6" {...containerProps}>
			{correlations.map((correlation) => (
				<section key={`${correlation.kind}:${correlation.identifier}`} className="space-y-2">
					{/* Header: title + link share a row; the (often long) identifier
					    gets its own truncating line so neither clips the other. */}
					<div className="space-y-0.5">
						<div className="flex items-center justify-between gap-2">
							<span className="text-[12px] font-medium text-foreground">
								{correlation.title}
							</span>
							<CorrelationLink correlation={correlation} />
						</div>
						<div
							className="truncate font-mono text-[11px] text-muted-foreground"
							title={correlation.identifier}
						>
							{correlation.identifier}
						</div>
					</div>
					{renderCharts(correlation, startTime, endTime, syncId)}
				</section>
			))}
		</div>
	)
}

function renderCharts(correlation: InfraCorrelation, startTime: string, endTime: string, syncId: string) {
	switch (correlation.kind) {
		// Pod/Node charts each render as a self-contained card whose legend
		// already names the metric, so they just stack — no extra card/label
		// wrapper (which previously double-bordered and duplicated the label).
		case "pod":
			return (
				<div className="space-y-3">
					{correlation.charts.map((c) => (
						<PodDetailChart
							key={c.metric}
							podName={correlation.identifier}
							namespace={correlation.namespace}
							metric={c.metric}
							startTime={startTime}
							endTime={endTime}
							bucketSeconds={BUCKET_SECONDS}
							syncId={syncId}
						/>
					))}
				</div>
			)
		case "node":
			return (
				<div className="space-y-3">
					{correlation.charts.map((c) => (
						<NodeDetailChart
							key={c.metric}
							nodeName={correlation.identifier}
							metric={c.metric}
							startTime={startTime}
							endTime={endTime}
							bucketSeconds={BUCKET_SECONDS}
							syncId={syncId}
						/>
					))}
				</div>
			)
		// Host charts are multi-series (CPU by state, etc.), so the legend shows
		// the states — give each its own full-width card with the metric name on
		// top. (MetricStrip's 160px label sidebar is for the wide host detail
		// page and would crowd/clip the legend in this narrow drawer.)
		case "host":
			return (
				<div className="space-y-3">
					{correlation.charts.map((c) => (
						<div key={c.metric} className="rounded-lg border bg-card p-4">
							<div className="mb-1 text-[12px] font-medium text-foreground">{c.label}</div>
							<HostDetailChart
								hostName={correlation.identifier}
								metric={c.metric}
								startTime={startTime}
								endTime={endTime}
								bucketSeconds={BUCKET_SECONDS}
								syncId={syncId}
							/>
						</div>
					))}
				</div>
			)
	}
}

/** Typed SPA deep-link into the matching infra detail route, per kind. */
function CorrelationLink({ correlation }: { correlation: InfraCorrelation }) {
	const className =
		"inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] text-muted-foreground transition-colors hover:text-foreground"
	const content = (
		<>
			View in Infrastructure
			<ExternalLinkIcon size={11} />
		</>
	)

	switch (correlation.kind) {
		case "pod":
			return (
				<Link
					to="/infra/kubernetes/pods/$podName"
					params={{ podName: correlation.identifier }}
					search={correlation.namespace ? { namespace: correlation.namespace } : {}}
					className={className}
				>
					{content}
				</Link>
			)
		case "node":
			return (
				<Link
					to="/infra/kubernetes/nodes/$nodeName"
					params={{ nodeName: correlation.identifier }}
					className={className}
				>
					{content}
				</Link>
			)
		case "host":
			return (
				<Link
					to="/infra/$hostName"
					params={{ hostName: correlation.identifier }}
					className={className}
				>
					{content}
				</Link>
			)
	}
}
