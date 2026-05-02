import { Link } from "@tanstack/react-router"
import type { ErrorIssueSampleTrace } from "@maple/domain/http"
import { Empty, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { getServiceColorClass } from "@maple/ui/lib/colors"
import { cn } from "@maple/ui/lib/utils"
import { formatRelativeTime } from "@/lib/format"

interface IssueOccurrencesTableProps {
	traces: ReadonlyArray<ErrorIssueSampleTrace>
}

export function IssueOccurrencesTable({ traces }: IssueOccurrencesTableProps) {
	if (traces.length === 0) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyTitle>No samples in window</EmptyTitle>
				</EmptyHeader>
			</Empty>
		)
	}

	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Time</TableHead>
					<TableHead>Service</TableHead>
					<TableHead>Message</TableHead>
					<TableHead>Trace</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{traces.map((trace) => (
					<TableRow key={`${trace.traceId}-${trace.spanId}`}>
						<TableCell
							className="tabular-nums text-muted-foreground"
							title={new Date(trace.timestamp).toLocaleString()}
						>
							{formatRelativeTime(trace.timestamp)}
						</TableCell>
						<TableCell>
							<span className="inline-flex items-center gap-1.5">
								<span
									aria-hidden
									className={cn(
										"size-1.5 shrink-0 rounded-full",
										getServiceColorClass(trace.serviceName),
									)}
								/>
								<span>{trace.serviceName}</span>
							</span>
						</TableCell>
						<TableCell className="max-w-sm truncate">{trace.exceptionMessage}</TableCell>
						<TableCell>
							<Link
								to="/traces/$traceId"
								params={{ traceId: trace.traceId }}
								search={{ t: trace.timestamp }}
								className={cn(
									"inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5",
									"font-mono text-[11px] text-muted-foreground tabular-nums",
									"transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary",
								)}
							>
								{trace.traceId.slice(0, 12)}…
							</Link>
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	)
}
