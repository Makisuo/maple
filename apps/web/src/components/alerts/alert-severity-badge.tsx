import type { AlertSeverity } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/utils"

const toneBySeverity: Record<AlertSeverity, string> = {
	warning: "border-severity-warn/30 bg-severity-warn/10 text-severity-warn",
	critical: "border-destructive/30 bg-destructive/10 text-destructive",
}

const labelBySeverity: Record<AlertSeverity, string> = {
	warning: "Warning",
	critical: "Critical",
}

export function AlertSeverityBadge({ severity, className }: { severity: AlertSeverity; className?: string }) {
	return (
		<Badge variant="outline" className={cn(toneBySeverity[severity], className)}>
			{labelBySeverity[severity]}
		</Badge>
	)
}
