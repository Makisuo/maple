import type { IssueKind } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/lib/utils"

/**
 * Marks non-error issues in the unified triage queue. Plain error issues are
 * the default and stay unbadged to keep rows quiet.
 */
export function IssueKindBadge({ kind, className }: { kind: IssueKind; className?: string }) {
	if (kind === "error") return null
	return (
		<Badge
			variant="outline"
			className={cn("bg-blue-500/10 text-blue-600 dark:text-blue-400", className)}
			title={
				kind === "alert"
					? "Created from an alert rule incident"
					: "Created from a third-party integration webhook"
			}
		>
			{kind}
		</Badge>
	)
}
