import { cn } from "@maple/ui/utils"

export type AlertStatusState = "firing" | "ok" | "disabled" | "resolved" | "pending"

const toneByState: Record<AlertStatusState, { dot: string; text: string; label: string }> = {
	firing: { dot: "bg-destructive", text: "text-destructive font-medium", label: "Firing" },
	ok: { dot: "bg-emerald-500", text: "text-emerald-500", label: "OK" },
	disabled: { dot: "bg-muted-foreground", text: "text-muted-foreground", label: "Disabled" },
	resolved: { dot: "bg-emerald-500", text: "text-emerald-500", label: "Resolved" },
	pending: { dot: "bg-amber-500", text: "text-amber-500", label: "Pending" },
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
