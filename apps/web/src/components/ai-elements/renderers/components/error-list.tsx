import { formatRelativeTime } from "@maple/ui/lib/time-format"
import type { RendererComponentProps } from "./types"

interface ErrorListProps {
	errors: Array<{
		errorType: string
		count: number
		affectedServices: string[]
		lastSeen: string
	}>
}

export function ErrorList({ props }: RendererComponentProps<ErrorListProps>) {
	const { errors } = props

	return (
		<div className="max-h-[300px] space-y-1 overflow-y-auto">
			{errors.map((err) => {
				const timeAgo = formatRelativeTime(err.lastSeen)
				return (
					<div
						key={err.errorType}
						className="flex items-start gap-2 rounded p-1 text-[11px] hover:bg-muted/50"
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
