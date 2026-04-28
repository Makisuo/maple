import { useNavigate } from "@tanstack/react-router"
import { cn } from "@maple/ui/utils"
import { Button } from "@maple/ui/components/ui/button"
import { signalLabel, type AlertContext } from "./alert-context"

interface AlertAttachmentCardProps {
	alert: AlertContext
	className?: string
}

const accentBySeverity: Record<string, { stripe: string; tint: string; label: string }> = {
	critical: { stripe: "bg-destructive", tint: "bg-destructive/[0.04]", label: "Critical" },
	warning: { stripe: "bg-severity-warn", tint: "bg-severity-warn/[0.04]", label: "Warning" },
}

const eventMeta: Record<string, { label: string; dot: string; text: string }> = {
	trigger: { label: "Triggered", dot: "bg-destructive", text: "text-destructive" },
	renotify: { label: "Re-notified", dot: "bg-amber-500", text: "text-amber-500" },
	resolve: { label: "Resolved", dot: "bg-emerald-500", text: "text-emerald-500" },
	test: { label: "Test", dot: "bg-sky-500", text: "text-sky-500" },
}

const capitalize = (s: string): string => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1))

const comparatorGlyph = (c: string): string => {
	switch (c) {
		case "gt":
			return ">"
		case "gte":
			return "≥"
		case "lt":
			return "<"
		case "lte":
			return "≤"
		default:
			return c
	}
}

const formatValue = (value: number | null, signal: string): string => {
	if (value === null || Number.isNaN(value)) return "—"
	const round = (v: number, d = 2) => {
		const f = 10 ** d
		return (Math.round(v * f) / f).toString()
	}
	switch (signal) {
		case "error_rate":
			return `${round(value)}%`
		case "p95_latency":
		case "p99_latency":
			return `${round(value)}ms`
		case "apdex":
			return round(value, 3)
		case "throughput":
			return `${round(value)} rpm`
		default:
			return round(value)
	}
}

const shortIncidentId = (id: string): string => {
	const segments = id.split("-")
	return segments.length > 1 ? segments[segments.length - 1]!.slice(0, 8) : id.slice(0, 8)
}

export function AlertAttachmentCard({ alert, className }: AlertAttachmentCardProps) {
	const navigate = useNavigate()
	const accent = accentBySeverity[alert.severity] ?? {
		stripe: "bg-muted-foreground",
		tint: "bg-muted/30",
		label: alert.severity,
	}
	const event = eventMeta[alert.eventType] ?? {
		label: alert.eventType,
		dot: "bg-muted-foreground",
		text: "text-muted-foreground",
	}
	const signal = capitalize(signalLabel(alert.signalType))
	const observed = formatValue(alert.value, alert.signalType)
	const threshold = formatValue(alert.threshold, alert.signalType)

	const detach = () => navigate({ to: "/chat", search: { tab: alertTabIdFor(alert) } })

	return (
		<div className={cn("mx-auto w-full max-w-3xl px-4 pt-3", className)}>
			<div
				className={cn(
					"relative overflow-hidden rounded-md border bg-card/80 shadow-sm backdrop-blur-sm",
					accent.tint,
				)}
			>
				<div className={cn("absolute inset-y-0 left-0 w-[3px]", accent.stripe)} aria-hidden />
				<div className="flex items-start gap-2 py-2.5 pr-2 pl-3.5">
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
							<span className="font-medium">Attached alert</span>
							<span className="size-0.5 rounded-full bg-muted-foreground/40" aria-hidden />
							<span className="font-mono">{accent.label}</span>
							<span className="size-0.5 rounded-full bg-muted-foreground/40" aria-hidden />
							<span className={cn("inline-flex items-center gap-1 font-mono", event.text)}>
								<span className={cn("size-1.5 rounded-full", event.dot)} aria-hidden />
								{event.label}
							</span>
							{alert.incidentId && (
								<>
									<span
										className="size-0.5 rounded-full bg-muted-foreground/40"
										aria-hidden
									/>
									<span className="font-mono normal-case tracking-normal">
										#{shortIncidentId(alert.incidentId)}
									</span>
								</>
							)}
						</div>
						<div className="mt-1 truncate text-[13px] font-medium text-foreground">
							{alert.ruleName}
						</div>
						<ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
							<AttachmentField label="Signal" value={signal} />
							<AttachmentField
								label="Observed"
								value={
									<span className="tabular-nums">
										<span className="font-semibold text-foreground">{observed}</span>
										<span className="mx-1.5 text-muted-foreground/60">
											{comparatorGlyph(alert.comparator)}
										</span>
										<span className="text-muted-foreground">{threshold}</span>
									</span>
								}
							/>
							<AttachmentField label="Window" value={`${alert.windowMinutes}m`} />
							<AttachmentField label="Group" value={alert.groupKey ?? "all"} />
						</ul>
					</div>
					<Button
						variant="ghost"
						size="icon"
						className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
						onClick={detach}
						aria-label="Detach alert"
						title="Detach alert"
					>
						<svg viewBox="0 0 16 16" fill="none" className="size-3">
							<path
								d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
							/>
						</svg>
					</Button>
				</div>
			</div>
		</div>
	)
}

function AttachmentField({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<li className="flex min-w-0 flex-col leading-tight">
			<span className="text-[9px] uppercase tracking-[0.14em] text-muted-foreground/70">{label}</span>
			<span className="truncate font-mono text-[11.5px] text-foreground">{value}</span>
		</li>
	)
}

const alertTabIdFor = (alert: AlertContext): string => `alert-${alert.incidentId ?? alert.ruleId}`
