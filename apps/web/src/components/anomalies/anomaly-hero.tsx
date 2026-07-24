import type { AnomalyIncidentDocument } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"

import { formatRelativeTime } from "@/lib/format"
import {
	deviation,
	formatSignalValue,
	isStaleOpenIncident,
	SIGNAL_LABEL,
	severityToneFor,
} from "./anomaly-format"

export function AnomalyHero({
	incident,
	className,
}: {
	incident: AnomalyIncidentDocument
	className?: string
}) {
	const tone = severityToneFor(incident)
	const isStale = isStaleOpenIncident(incident)
	const dev = deviation(incident)
	const observed = formatSignalValue(incident.signalType, incident.lastObservedValue)
	const baseline = formatSignalValue(incident.signalType, incident.baselineMedian)
	const threshold = formatSignalValue(incident.signalType, incident.thresholdValue)

	return (
		<div className={cn("space-y-2", className)}>
			<div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				Anomaly
			</div>
			<h1 className="text-3xl font-semibold leading-tight text-foreground break-words sm:text-4xl">
				{SIGNAL_LABEL[incident.signalType]}
				<span className="text-muted-foreground/60"> · </span>
				{incident.serviceName}
			</h1>
			<p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
				{isStale ? "Last recorded" : "Observed"}{" "}
				<span
					className={cn(
						"font-mono font-medium",
						incident.status === "open" && !isStale ? tone.text : "text-foreground",
					)}
				>
					{observed}
				</span>{" "}
				against a <span className="font-mono text-foreground">{baseline}</span> 7-day baseline —{" "}
				<span
					className={cn(
						"font-mono font-medium",
						incident.status === "open" && !isStale ? tone.text : "text-foreground",
					)}
				>
					{dev.label}
				</span>
				{dev.kind === "sigma" ? " above median" : dev.kind === "percent" ? " vs baseline" : ""},
				threshold <span className="font-mono text-foreground">{threshold}</span>.
				{isStale
					? ` Last triggered ${formatRelativeTime(incident.lastTriggeredAt)}; this stale detector state does not represent current service health.`
					: ""}
			</p>
		</div>
	)
}
