import type { ErrorIssueId, WorkflowState } from "@maple/domain/http"
import { allowedTransitionsForAll } from "@maple/domain/http"
import type { ReactNode } from "react"
import { Button } from "@maple/ui/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"

import { WORKFLOW_LABEL } from "@/components/icons/workflow-ring"
import { XmarkIcon } from "@/components/icons"
import { SEVERITY_LABEL, SEVERITY_ORDER, SeverityDot } from "./severity-badge"
import type { IssueMutations } from "./use-issue-mutations"

/**
 * A selected row carries its workflow state, not just its id: the "Move to"
 * menu can only know which moves are legal for the whole selection if it knows
 * where every selected issue currently sits.
 */
export interface SelectedIssue {
	readonly id: ErrorIssueId
	readonly state: WorkflowState
}

export function IssuesBulkBar({
	selected,
	mutations,
	onClear,
}: {
	selected: ReadonlyArray<SelectedIssue>
	mutations: IssueMutations
	onClear: () => void
}) {
	if (selected.length === 0) return null

	const selectedIds = selected.map((issue) => issue.id)
	// The intersection of every selected issue's legal moves, so a bulk
	// transition either applies to the whole selection or is not offered.
	const targets = allowedTransitionsForAll(selected.map((issue) => issue.state))

	return (
		<div
			role="region"
			aria-label="Bulk actions"
			className="pointer-events-auto fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 border bg-popover p-1"
		>
			<span className="px-2 text-xs font-medium tabular-nums text-foreground">
				{selectedIds.length} selected
			</span>
			<Button
				size="sm"
				variant="ghost"
				onClick={() => {
					void mutations.claimMany(selectedIds)
					onClear()
				}}
			>
				Claim
			</Button>
			<BulkMenu label="Severity">
				<DropdownMenuLabel>Set severity</DropdownMenuLabel>
				<DropdownMenuSeparator />
				{SEVERITY_ORDER.map((severity) => (
					<DropdownMenuItem
						key={severity}
						className="flex items-center gap-2"
						onClick={() => {
							void mutations.setSeverityMany(selectedIds, severity)
							onClear()
						}}
					>
						<SeverityDot severity={severity} />
						{SEVERITY_LABEL[severity]}
					</DropdownMenuItem>
				))}
				<DropdownMenuItem
					className="flex items-center gap-2"
					onClick={() => {
						void mutations.setSeverityMany(selectedIds, null)
						onClear()
					}}
				>
					<SeverityDot severity={null} />
					Clear severity
				</DropdownMenuItem>
			</BulkMenu>
			<BulkMenu label="Move to">
				<DropdownMenuLabel>Move to state</DropdownMenuLabel>
				<DropdownMenuSeparator />
				{targets.length === 0 ? (
					<DropdownMenuItem disabled>
						{selected.length === 1
							? `No moves from ${WORKFLOW_LABEL[selected[0]!.state]}`
							: "No move applies to every selected issue"}
					</DropdownMenuItem>
				) : (
					targets.map((state) => (
						<DropdownMenuItem
							key={state}
							onClick={() => {
								void mutations.transitionMany(selectedIds, state)
								onClear()
							}}
						>
							{WORKFLOW_LABEL[state]}
						</DropdownMenuItem>
					))
				)}
			</BulkMenu>
			<Button size="icon-sm" variant="ghost" onClick={onClear} aria-label="Clear selection">
				<XmarkIcon size={14} />
			</Button>
		</div>
	)
}

function BulkMenu({ label, children }: { label: string; children: ReactNode }) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<Button size="sm" variant="ghost" />}>{label}</DropdownMenuTrigger>
			<DropdownMenuContent align="center">
				<DropdownMenuGroup>{children}</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
