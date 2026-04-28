import type { ErrorIssueDocument } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"

interface IssueHeroProps {
	issue: ErrorIssueDocument
	className?: string
}

export function IssueHero({ issue, className }: IssueHeroProps) {
	const exceptionType = issue.exceptionType || "Unknown error"
	return (
		<div className={cn("space-y-4", className)}>
			<div className="space-y-2">
				<div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
					Exception
				</div>
				<h1 className="text-3xl font-semibold leading-tight text-foreground break-words sm:text-4xl">
					{exceptionType}
				</h1>
				{issue.exceptionMessage ? (
					<p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
						{issue.exceptionMessage}
					</p>
				) : null}
			</div>
			{issue.topFrame ? (
				<pre
					className={cn(
						"overflow-x-auto rounded-md border border-border/60 bg-muted/40 px-3 py-2",
						"font-mono text-[11px] leading-relaxed text-muted-foreground",
					)}
				>
					<code className="text-foreground/80">{issue.topFrame}</code>
				</pre>
			) : null}
		</div>
	)
}
