import type { BaseComponentProps } from "@json-render/react"
import { SeverityBadge } from "@/components/logs/severity-badge"

interface LogListProps {
	logs: Array<{
		timestamp: string
		severityText: string
		serviceName: string
		body: string
		traceId?: string
		spanId?: string
	}>
	totalCount?: number
}

export function LogList({ props }: BaseComponentProps<LogListProps>) {
	const { logs, totalCount } = props

	return (
		<div className="space-y-1">
			{totalCount != null && (
				<p className="text-[10px] text-muted-foreground">
					{totalCount.toLocaleString()} total logs
					{totalCount > logs.length && ` (showing ${logs.length})`}
				</p>
			)}
			<div className="max-h-[300px] space-y-0.5 overflow-y-auto">
				{logs.map((log, i) => {
					const time = new Date(log.timestamp).toLocaleTimeString()
					return (
						<div
							key={`${log.timestamp}-${i}`}
							className="flex items-start gap-1.5 rounded px-1 py-0.5 text-[11px] hover:bg-muted/50"
						>
							<span className="shrink-0 font-mono text-[10px] text-muted-foreground">
								{time}
							</span>
							<SeverityBadge severity={log.severityText} className="shrink-0" />
							<span className="shrink-0 text-muted-foreground">{log.serviceName}</span>
							<span className="min-w-0 flex-1 truncate">{log.body}</span>
							{log.traceId && (
								<a
									href={`/traces/${log.traceId}`}
									className="shrink-0 text-primary hover:underline"
									title={log.traceId}
								>
									trace
								</a>
							)}
						</div>
					)
				})}
			</div>
		</div>
	)
}
