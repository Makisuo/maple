import { cn } from "@maple/ui/lib/utils"

interface IssueNotesCalloutProps {
	notes: string
	className?: string
}

export function IssueNotesCallout({ notes, className }: IssueNotesCalloutProps) {
	return (
		<div
			className={cn(
				"relative rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3",
				className,
			)}
		>
			<div className="mb-1 text-[10px] font-medium uppercase tracking-[0.12em] text-amber-600 dark:text-amber-400">
				Notes
			</div>
			<div className="whitespace-pre-wrap text-sm text-foreground">{notes}</div>
		</div>
	)
}
