import type { ReactNode } from "react"
import type { ErrorIssueDocument } from "@maple/domain/http"
import { allowedTransitionsForAll } from "@maple/domain/http"
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@maple/ui/components/ui/context-menu"

import { WORKFLOW_LABEL, WorkflowRingIcon } from "@/components/icons/workflow-ring"
import { CheckIcon } from "@/components/icons"
import { useCopy } from "@maple/ui/hooks/use-copy"
import { agentPromptFromIssue } from "./agent-debug-prompt"
import type { IssueMutations } from "./use-issue-mutations"

export function IssueContextMenu({
	issue,
	mutations,
	issueUrl,
	onOpenInNewTab,
	children,
}: {
	issue: ErrorIssueDocument
	mutations: IssueMutations
	issueUrl: string
	onOpenInNewTab: () => void
	children: ReactNode
}) {
	// The offered moves come from the domain matrix the server enforces, so the
	// menu can never present a transition the API would reject — a `cancelled`
	// issue offers nothing at all.
	const targets = allowedTransitionsForAll([issue.workflowState])
	const canClaim = !issue.leaseHolder
	const canRelease = Boolean(issue.leaseHolder)

	const idCopy = useCopy({ label: "Issue ID" })
	const linkCopy = useCopy({ label: "Link" })
	const promptCopy = useCopy({
		label: "Agent prompt",
		successMessage: "Agent prompt copied — paste it into your MCP agent",
	})

	const copyId = () => void idCopy.copy(issue.id)
	const copyUrl = () => void linkCopy.copy(window.location.origin + issueUrl)
	const copyAgentPrompt = () => void promptCopy.copy(agentPromptFromIssue(issue))

	return (
		<ContextMenu>
			<ContextMenuTrigger render={<div>{children}</div>} />
			<ContextMenuContent className="w-56 p-1">
				<ContextMenuSub>
					<ContextMenuSubTrigger>
						<WorkflowRingIcon state={issue.workflowState} size={14} />
						<span>Change status</span>
					</ContextMenuSubTrigger>
					<ContextMenuSubContent className="w-56 p-1">
						<ContextMenuItem disabled>
							<WorkflowRingIcon state={issue.workflowState} size={14} />
							<span className="flex-1">{WORKFLOW_LABEL[issue.workflowState]}</span>
							<CheckIcon size={12} className="text-muted-foreground" />
						</ContextMenuItem>
						{targets.length === 0 ? (
							<ContextMenuItem disabled>
								<span className="flex-1">
									No moves from {WORKFLOW_LABEL[issue.workflowState]}
								</span>
							</ContextMenuItem>
						) : (
							targets.map((state) => (
								<ContextMenuItem
									key={state}
									onClick={() => void mutations.transitionTo(issue.id, state)}
								>
									<WorkflowRingIcon state={state} size={14} />
									<span className="flex-1">{WORKFLOW_LABEL[state]}</span>
								</ContextMenuItem>
							))
						)}
					</ContextMenuSubContent>
				</ContextMenuSub>

				{canClaim ? (
					<ContextMenuItem onClick={() => void mutations.claimIssue(issue.id)}>
						Claim
					</ContextMenuItem>
				) : null}
				{canRelease ? (
					<ContextMenuItem onClick={() => void mutations.releaseIssue(issue.id)}>
						Release
					</ContextMenuItem>
				) : null}

				<ContextMenuSeparator />
				<ContextMenuItem onClick={onOpenInNewTab}>Open in new tab</ContextMenuItem>
				<ContextMenuItem onClick={copyUrl}>Copy link</ContextMenuItem>
				<ContextMenuItem onClick={copyId}>Copy ID</ContextMenuItem>
				{issue.kind === "error" ? (
					<ContextMenuItem onClick={copyAgentPrompt}>Copy agent prompt</ContextMenuItem>
				) : null}
			</ContextMenuContent>
		</ContextMenu>
	)
}
