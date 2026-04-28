import type { ErrorIncidentDocument } from "@maple/domain/http"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { cn } from "@maple/ui/lib/utils"
import { formatRelativeTime } from "@/lib/format"

interface IssueIncidentsTableProps {
	incidents: ReadonlyArray<ErrorIncidentDocument>
}

const REASON_LABEL: Record<ErrorIncidentDocument["reason"], string> = {
	first_seen: "First seen",
	regression: "Regression",
	manual: "Manual",
}

export function IssueIncidentsTable({ incidents }: IssueIncidentsTableProps) {
	if (incidents.length === 0) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyTitle>No incidents yet</EmptyTitle>
					<EmptyDescription>Incidents open on first-seen or regression events.</EmptyDescription>
				</EmptyHeader>
			</Empty>
		)
	}

	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead className="w-8 p-0" aria-label="Status accent" />
					<TableHead>Status</TableHead>
					<TableHead>Reason</TableHead>
					<TableHead>Opened</TableHead>
					<TableHead>Last triggered</TableHead>
					<TableHead className="text-right">Events</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{incidents.map((incident) => {
					const isOpen = incident.status === "open"
					return (
						<TableRow key={incident.id}>
							<TableCell className="w-8 p-0">
								<span
									aria-hidden
									className={cn(
										"block h-full w-[3px]",
										isOpen ? "bg-destructive" : "bg-border/60",
									)}
								/>
							</TableCell>
							<TableCell>
								<span className="inline-flex items-center gap-2">
									<span className="relative inline-flex size-1.5">
										{isOpen ? (
											<>
												<span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive opacity-60" />
												<span className="relative inline-flex size-full rounded-full bg-destructive" />
											</>
										) : (
											<span className="relative inline-flex size-full rounded-full bg-muted-foreground/60" />
										)}
									</span>
									<span
										className={cn(
											"text-xs font-medium uppercase tracking-wide",
											isOpen ? "text-destructive" : "text-muted-foreground",
										)}
									>
										{incident.status}
									</span>
								</span>
							</TableCell>
							<TableCell className="text-muted-foreground">
								{REASON_LABEL[incident.reason]}
							</TableCell>
							<TableCell
								className="tabular-nums text-muted-foreground"
								title={new Date(incident.firstTriggeredAt).toLocaleString()}
							>
								{formatRelativeTime(incident.firstTriggeredAt)}
							</TableCell>
							<TableCell
								className="tabular-nums"
								title={new Date(incident.lastTriggeredAt).toLocaleString()}
							>
								{formatRelativeTime(incident.lastTriggeredAt)}
							</TableCell>
							<TableCell className="text-right font-mono tabular-nums">
								{incident.occurrenceCount.toLocaleString()}
							</TableCell>
						</TableRow>
					)
				})}
			</TableBody>
		</Table>
	)
}
