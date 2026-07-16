import { cn } from "@maple/ui/utils"

export type AlertStatusState =
	| "firing"
	| "ok"
	| "disabled"
	| "resolved"
	| "pending"
	| "error"
	| "stale"
	| "no-data"

const toneByState: Record<AlertStatusState, { dot: string; text: string; label: string }> = {
	firing: { dot: "bg-destructive", text: "text-destructive font-medium", label: "Firing" },
	ok: { dot: "bg-success", text: "text-success", label: "OK" },
	disabled: { dot: "bg-muted-foreground", text: "text-muted-foreground", label: "Disabled" },
	resolved: { dot: "bg-success", text: "text-success", label: "Resolved" },
	pending: { dot: "bg-warning", text: "text-warning", label: "Pending" },
	error: { dot: "bg-warning", text: "text-warning font-medium", label: "Error" },
	stale: { dot: "bg-warning", text: "text-warning", label: "Stale" },
	"no-data": { dot: "bg-muted-foreground", text: "text-muted-foreground", label: "No data" },
}

export function AlertStatusBadge({
	state,
	label,
	className,
}: {
	state: AlertStatusState
	label?: string
	className?: string
}) {
	const tone = toneByState[state]
	return (
		<span className={cn("inline-flex items-center gap-1.5 text-xs", tone.text, className)}>
			<span className={cn("size-1.5 rounded-full", tone.dot)} />
			<span>{label ?? tone.label}</span>
		</span>
	)
}
