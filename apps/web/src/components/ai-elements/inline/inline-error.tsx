import { formatNumber } from "@/lib/format"
import type { InlineErrorData } from "./types"

export function InlineError({ data }: { data: InlineErrorData }) {
	return (
		<div className="my-1 flex items-center gap-2 rounded-lg border border-border/40 bg-muted/30 px-3 py-2 text-[11px]">
			<span className="min-w-0 truncate text-severity-error" title={data.errorType}>
				{data.errorType.length > 80 ? `${data.errorType.slice(0, 80)}...` : data.errorType}
			</span>
			<span className="shrink-0 rounded bg-severity-error/10 px-1.5 py-0.5 font-mono text-[10px] text-severity-error">
				{formatNumber(data.count)}
			</span>
			{data.affectedServices && data.affectedServices.length > 0 && (
				<div className="ml-auto flex shrink-0 gap-1">
					{data.affectedServices.slice(0, 3).map((svc) => (
						<span
							key={svc}
							className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground"
						>
							{svc}
						</span>
					))}
					{data.affectedServices.length > 3 && (
						<span className="text-[10px] text-muted-foreground">
							+{data.affectedServices.length - 3}
						</span>
					)}
				</div>
			)}
		</div>
	)
}
