import type { ErrorIssueId, IssueSeverity, WorkflowState } from "@maple/domain/http"
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
import type { IssueMutations } from "./use-issue-mutations"

const STATE_ORDER: ReadonlyArray<WorkflowState> = [
	"triage",
	"todo",
	"in_progress",
	"in_review",
	"done",
	"cancelled",
	"wontfix",
]
const SEVERITIES: ReadonlyArray<IssueSeverity> = ["critical", "high", "medium", "low"]

export function IssuesBulkBar({
	selectedIds,
	mutations,
	onClear,
}: {
	selectedIds: ReadonlyArray<ErrorIssueId>
	mutations: IssueMutations
	onClear: () => void
}) {
	if (selectedIds.length === 0) return null

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
				{SEVERITIES.map((severity) => (
					<DropdownMenuItem
						key={severity}
						className="capitalize"
						onClick={() => {
							void mutations.setSeverityMany(selectedIds, severity)
							onClear()
						}}
					>
						{severity}
					</DropdownMenuItem>
				))}
				<DropdownMenuItem
					onClick={() => {
						void mutations.setSeverityMany(selectedIds, null)
						onClear()
					}}
				>
					Clear severity
				</DropdownMenuItem>
			</BulkMenu>
			<BulkMenu label="Move to">
				<DropdownMenuLabel>Move to state</DropdownMenuLabel>
				<DropdownMenuSeparator />
				{STATE_ORDER.map((state) => (
					<DropdownMenuItem
						key={state}
						onClick={() => {
							void mutations.transitionMany(selectedIds, state)
							onClear()
						}}
					>
						{WORKFLOW_LABEL[state]}
					</DropdownMenuItem>
				))}
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
