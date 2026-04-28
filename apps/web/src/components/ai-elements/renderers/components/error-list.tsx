import type { BaseComponentProps } from "@json-render/react"

interface ErrorListProps {
	errors: Array<{
		errorType: string
		count: number
		affectedServices: string[]
		lastSeen: string
	}>
}

export function ErrorList({ props }: BaseComponentProps<ErrorListProps>) {
	const { errors } = props

	return (
		<div className="max-h-[300px] space-y-1 overflow-y-auto">
			{errors.map((err, i) => {
				const lastSeen = new Date(err.lastSeen)
				const timeAgo = formatTimeAgo(lastSeen)
				return (
					<div
						key={`${err.errorType}-${i}`}
						className="flex items-start gap-2 rounded px-1 py-1 text-[11px] hover:bg-muted/50"
					>
						<span className="min-w-0 flex-1 truncate text-severity-error" title={err.errorType}>
							{err.errorType.length > 60 ? `${err.errorType.slice(0, 60)}...` : err.errorType}
						</span>
						<span className="shrink-0 rounded bg-severity-error/10 px-1.5 py-0.5 font-mono text-[10px] text-severity-error">
							{err.count}
						</span>
						<div className="flex shrink-0 gap-1">
							{err.affectedServices.slice(0, 2).map((svc) => (
								<span
									key={svc}
									className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground"
								>
									{svc}
								</span>
							))}
							{err.affectedServices.length > 2 && (
								<span className="text-[10px] text-muted-foreground">
									+{err.affectedServices.length - 2}
								</span>
							)}
						</div>
						<span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo}</span>
					</div>
				)
			})}
		</div>
	)
}

function formatTimeAgo(date: Date): string {
	const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
	if (seconds < 60) return `${seconds}s ago`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const days = Math.floor(hours / 24)
	return `${days}d ago`
}
