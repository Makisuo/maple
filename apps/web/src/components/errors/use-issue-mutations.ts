import { Cause, Exit } from "effect"
import { toastManager } from "@maple/ui/components/ui/toast"
import { useAtomSet } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
	ErrorIssueClaimRequest,
	ErrorIssueReleaseRequest,
	ErrorIssueSetSeverityRequest,
	ErrorIssueTransitionRequest,
	type ErrorIssueId,
	type IssueSeverity,
	type WorkflowState,
} from "@maple/domain/http"
import { WORKFLOW_LABEL } from "@/components/icons/workflow-ring"
import { logClientError } from "@/lib/services/common/telemetry"

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
	logClientError("issue.mutation_failed", result.cause, {
		"maple.issue.mutation": label,
	})
}

export function useIssueMutations(onSuccess?: () => void) {
	const transition = useAtomSet(MapleApiAtomClient.mutation("errors", "transitionIssue"), {
		mode: "promiseExit",
	})
	const claim = useAtomSet(MapleApiAtomClient.mutation("errors", "claimIssue"), { mode: "promiseExit" })
	const release = useAtomSet(MapleApiAtomClient.mutation("errors", "releaseIssue"), { mode: "promiseExit" })
	const severity = useAtomSet(MapleApiAtomClient.mutation("errors", "setIssueSeverity"), {
		mode: "promiseExit",
	})

	const transitionTo = async (issueId: ErrorIssueId, toState: WorkflowState) => {
		const result = await transition({
			params: { issueId },
			payload: new ErrorIssueTransitionRequest({ toState }),
			reactivityKeys: [...INVALIDATE, `errorIssue:${issueId}`],
		})
		if (Exit.isSuccess(result)) {
			onSuccess?.()
			toastManager.add({ title: `Moved to ${WORKFLOW_LABEL[toState]}`, type: "success" })
		} else {
			logFailure("transitionTo", result)
			toastManager.add({
				title: "State change failed",
				description: describeFailure(result),
				type: "error",
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
			onSuccess?.()
			toastManager.add({
				title: `Moved ${issueIds.length} to ${WORKFLOW_LABEL[toState]}`,
				type: "success",
			})
		} else if (failed < issueIds.length) {
			onSuccess?.()
			toastManager.add({
				title: `Moved ${issueIds.length - failed} of ${issueIds.length}; ${failed} failed`,
				description: describeFailure(failures[0]!),
				type: "warning",
			})
		} else {
			toastManager.add({
				title: "State change failed",
				description: describeFailure(failures[0]!),
				type: "error",
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
			onSuccess?.()
			toastManager.add({ title: "Claimed", type: "success" })
		} else {
			logFailure("claim", result)
			toastManager.add({ title: "Claim failed", description: describeFailure(result), type: "error" })
		}
		return result
	}

	const claimMany = async (issueIds: ReadonlyArray<ErrorIssueId>) => {
		if (issueIds.length === 0) return
		const results = await Promise.all(
			issueIds.map((issueId) =>
				claim({
					params: { issueId },
					payload: new ErrorIssueClaimRequest({}),
					reactivityKeys: [...INVALIDATE, `errorIssue:${issueId}`],
				}),
			),
		)
		const failed = results.filter((result) => !Exit.isSuccess(result))
		if (failed.length === 0) {
			onSuccess?.()
			toastManager.add({ title: `Claimed ${issueIds.length} issues`, type: "success" })
		} else {
			toastManager.add({
				title: `Claimed ${issueIds.length - failed.length} of ${issueIds.length}`,
				type: "error",
			})
		}
	}

	const releaseIssue = async (issueId: ErrorIssueId) => {
		const result = await release({
			params: { issueId },
			payload: new ErrorIssueReleaseRequest({}),
			reactivityKeys: [...INVALIDATE, `errorIssue:${issueId}`],
		})
		if (Exit.isSuccess(result)) {
			onSuccess?.()
			toastManager.add({ title: "Released", type: "success" })
		} else {
			logFailure("release", result)
			toastManager.add({ title: "Release failed", description: describeFailure(result), type: "error" })
		}
		return result
	}

	const setSeverity = async (issueId: ErrorIssueId, value: IssueSeverity | null) => {
		const result = await severity({
			params: { issueId },
			payload: new ErrorIssueSetSeverityRequest({ severity: value }),
			reactivityKeys: [...INVALIDATE, `errorIssue:${issueId}`],
		})
		if (Exit.isSuccess(result)) {
			onSuccess?.()
			toastManager.add({
				title: value === null ? "Severity cleared" : `Severity set to ${value}`,
				type: "success",
			})
		} else {
			logFailure("setSeverity", result)
			toastManager.add({
				title: "Severity change failed",
				description: describeFailure(result),
				type: "error",
			})
		}
		return result
	}

	const setSeverityMany = async (issueIds: ReadonlyArray<ErrorIssueId>, value: IssueSeverity | null) => {
		if (issueIds.length === 0) return
		const results = await Promise.all(
			issueIds.map((issueId) =>
				severity({
					params: { issueId },
					payload: new ErrorIssueSetSeverityRequest({ severity: value }),
					reactivityKeys: [...INVALIDATE, `errorIssue:${issueId}`],
				}),
			),
		)
		const failed = results.filter((result) => !Exit.isSuccess(result))
		if (failed.length === 0) {
			onSuccess?.()
			toastManager.add({ title: `Updated severity for ${issueIds.length} issues`, type: "success" })
		} else {
			toastManager.add({
				title: `Updated ${issueIds.length - failed.length} of ${issueIds.length} issues`,
				type: "error",
			})
		}
	}

	return {
		transitionTo,
		transitionMany,
		claimIssue,
		claimMany,
		releaseIssue,
		setSeverity,
		setSeverityMany,
	}
}

export type IssueMutations = ReturnType<typeof useIssueMutations>
