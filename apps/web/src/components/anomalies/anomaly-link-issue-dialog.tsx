import { useMemo, useState } from "react"
import { Result, useAtomValue } from "@/lib/effect-atom"
import type { AnomalyIncidentDocument, ErrorIssueDocument, ErrorIssueId } from "@maple/domain/http"
import {
	Command,
	CommandDialog,
	CommandDialogPopup,
	CommandEmpty,
	CommandGroup,
	CommandGroupLabel,
	CommandInput,
	CommandItem,
	CommandList,
} from "@maple/ui/components/ui/command"
import { Spinner } from "@maple/ui/components/ui/spinner"

import { shortIssueId } from "@/components/errors/issue-id"
import { WorkflowRingIcon } from "@/components/icons"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { retainedQuery } from "@/lib/services/common/atom-client"

export function AnomalyLinkIssueDialog({
	incident,
	open,
	onOpenChange,
	onSelect,
}: {
	incident: AnomalyIncidentDocument
	open: boolean
	onOpenChange: (open: boolean) => void
	onSelect: (issueId: ErrorIssueId) => void
}) {
	return (
		// Gate the popup on `open` so it unmounts cleanly (see command-palette.tsx
		// for the base-ui backdrop rationale).
		<CommandDialog open={open} onOpenChange={onOpenChange}>
			{open && <DialogContent incident={incident} onSelect={onSelect} />}
		</CommandDialog>
	)
}

function DialogContent({
	incident,
	onSelect,
}: {
	incident: AnomalyIncidentDocument
	onSelect: (issueId: ErrorIssueId) => void
}) {
	const [query, setQuery] = useState("")
	const [allServices, setAllServices] = useState(false)

	const issuesQueryAtom = retainedQuery("errors", "listIssues", {
		query: allServices ? { limit: 100 } : { service: incident.serviceName, limit: 100 },
		reactivityKeys: ["errorIssues"],
	})
	const issuesResult = useAtomValue(issuesQueryAtom)

	const issues = Result.builder(issuesResult)
		.onSuccess((value) => value.issues)
		.orElse(() => [] as ReadonlyArray<ErrorIssueDocument>)

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase()
		const matches =
			q.length === 0
				? issues
				: issues.filter(
						(issue) =>
							issue.exceptionType.toLowerCase().includes(q) ||
							issue.exceptionMessage.toLowerCase().includes(q) ||
							issue.serviceName.toLowerCase().includes(q) ||
							shortIssueId(issue.id).toLowerCase().includes(q),
					)
		// Don't offer the already-linked issue.
		return matches.filter((issue) => issue.id !== incident.errorIssueId)
	}, [issues, query, incident.errorIssueId])

	const loading = Result.isInitial(issuesResult)

	return (
		<CommandDialogPopup>
			<Command
				inline={false}
				filter={null}
				value={query}
				onValueChange={(value: string) => setQuery(value)}
			>
				<CommandInput
					placeholder={`Search issues${allServices ? "" : ` in ${incident.serviceName}`}…`}
				/>
				<CommandList>
					{loading ? (
						<div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
							<Spinner className="size-3.5" /> Loading issues…
						</div>
					) : filtered.length === 0 ? (
						<CommandEmpty>
							{query.length > 0
								? `No issues matching “${query}”.`
								: allServices
									? "No issues found."
									: `No issues for ${incident.serviceName}.`}
						</CommandEmpty>
					) : (
						<CommandGroup>
							<CommandGroupLabel>
								{allServices ? "All services" : incident.serviceName}
							</CommandGroupLabel>
							{filtered.map((issue) => (
								<CommandItem
									key={issue.id}
									value={issue.id}
									onClick={() => onSelect(issue.id)}
								>
									<span className="flex min-w-0 flex-1 items-center gap-2">
										<WorkflowRingIcon state={issue.workflowState} size={14} />
										<span className="truncate text-foreground">
											{issue.exceptionType || "Unknown error"}
										</span>
										{issue.exceptionMessage ? (
											<span className="truncate text-muted-foreground">
												{issue.exceptionMessage}
											</span>
										) : null}
									</span>
									<span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
										<code className="font-mono tabular-nums">
											{shortIssueId(issue.id)}
										</code>
										<span className="tabular-nums">
											{formatRelativeTime(issue.lastSeenAt)}
										</span>
									</span>
								</CommandItem>
							))}
						</CommandGroup>
					)}
				</CommandList>
				<div className="flex items-center justify-between border-t border-border/60 px-3 py-2">
					<span className="text-xs text-muted-foreground">
						{allServices
							? "Showing issues across all services"
							: `Scoped to ${incident.serviceName}`}
					</span>
					<button
						type="button"
						onClick={() => setAllServices((prev) => !prev)}
						className="text-xs text-primary hover:underline"
					>
						{allServices ? `Only ${incident.serviceName}` : "Search all services"}
					</button>
				</div>
			</Command>
		</CommandDialogPopup>
	)
}
