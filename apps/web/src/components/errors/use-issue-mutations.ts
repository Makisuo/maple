import { Cause, Exit } from "effect"
import { toast } from "sonner"
import { useAtomSet } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
	ErrorIssueClaimRequest,
	ErrorIssueReleaseRequest,
	ErrorIssueTransitionRequest,
	type ErrorIssueId,
	type WorkflowState,
} from "@maple/domain/http"
import { WORKFLOW_LABEL } from "@/components/icons/workflow-ring"

const INVALIDATE = ["errorIssues"] as const

function describeFailure(result: Exit.Exit<unknown, unknown>): string {
	if (Exit.isSuccess(result)) return ""
	const errors = Cause.prettyErrors(result.cause)
	const first = errors[0]
	if (first?.message) return first.message
	return Cause.pretty(result.cause).slice(0, 300)
}

function logFailure(label: string, result: Exit.Exit<unknown, unknown>) {
	if (Exit.isSuccess(result)) return
	console.error(`[issue-mutations] ${label} failed`, result.cause)
}

export function useIssueMutations() {
	const transition = useAtomSet(MapleApiAtomClient.mutation("errors", "transitionIssue"), {
		mode: "promiseExit",
	})
	const claim = useAtomSet(MapleApiAtomClient.mutation("errors", "claimIssue"), { mode: "promiseExit" })
	const release = useAtomSet(MapleApiAtomClient.mutation("errors", "releaseIssue"), { mode: "promiseExit" })

	const transitionTo = async (issueId: ErrorIssueId, toState: WorkflowState) => {
		const result = await transition({
			params: { issueId },
			payload: new ErrorIssueTransitionRequest({ toState }),
			reactivityKeys: [...INVALIDATE, `errorIssue:${issueId}`],
		})
		if (Exit.isSuccess(result)) {
			toast.success(`Moved to ${WORKFLOW_LABEL[toState]}`)
		} else {
			logFailure("transitionTo", result)
			toast.error("State change failed", {
				description: describeFailure(result),
			})
		}
		return result
	}

	const transitionMany = async (issueIds: ReadonlyArray<ErrorIssueId>, toState: WorkflowState) => {
		if (issueIds.length === 0) return
		const results = await Promise.all(
			issueIds.map((issueId) =>
				transition({
					params: { issueId },
					payload: new ErrorIssueTransitionRequest({ toState }),
					reactivityKeys: [...INVALIDATE, `errorIssue:${issueId}`],
				}),
			),
		)
		const failures = results.filter((r) => !Exit.isSuccess(r))
		const failed = failures.length
		failures.forEach((r) => logFailure("transitionMany", r))
		if (failed === 0) {
			toast.success(`Moved ${issueIds.length} to ${WORKFLOW_LABEL[toState]}`)
		} else if (failed < issueIds.length) {
			toast.warning(`Moved ${issueIds.length - failed} of ${issueIds.length}; ${failed} failed`, {
				description: describeFailure(failures[0]!),
			})
		} else {
			toast.error("State change failed", {
				description: describeFailure(failures[0]!),
			})
		}
	}

	const claimIssue = async (issueId: ErrorIssueId) => {
		const result = await claim({
			params: { issueId },
			payload: new ErrorIssueClaimRequest({}),
			reactivityKeys: [...INVALIDATE, `errorIssue:${issueId}`],
		})
		if (Exit.isSuccess(result)) {
			toast.success("Claimed")
		} else {
			logFailure("claim", result)
			toast.error("Claim failed", { description: describeFailure(result) })
		}
		return result
	}

	const releaseIssue = async (issueId: ErrorIssueId) => {
		const result = await release({
			params: { issueId },
			payload: new ErrorIssueReleaseRequest({}),
			reactivityKeys: [...INVALIDATE, `errorIssue:${issueId}`],
		})
		if (Exit.isSuccess(result)) {
			toast.success("Released")
		} else {
			logFailure("release", result)
			toast.error("Release failed", { description: describeFailure(result) })
		}
		return result
	}

	return { transitionTo, transitionMany, claimIssue, releaseIssue }
}

export type IssueMutations = ReturnType<typeof useIssueMutations>
