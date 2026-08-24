import { ToolCallScorer } from "vitest-evals"
import { describeMapleEval, predictToolCalls, FIXTURES } from "./utils"

/**
 * Does a real model actually pick up an issue before working it?
 *
 * It did not. Across 50 live issues in the internal org, `lease_holder` was null
 * on every single one — `claim_error_issue` had never been called in production,
 * by any agent, ever. Agents walked `transition_error_issue` to `in_progress` by
 * hand instead, or went straight for `propose_fix` and got back "Illegal
 * transition from 'triage' to 'in_review'" (18 occurrences in two days).
 *
 * The server-side fix makes the claim happen either way — `propose_fix` and a
 * transition to `in_progress` both take the lease now. These cases guard the
 * other half: that the tool an agent reaches for is one of the ones that claims,
 * and never a bare state walk that pretends work has started without holding it.
 */
describeMapleEval("error issue workflow", {
	data: async () => [
		// The canonical pickup. `claim_error_issue` is the direct answer; a
		// transition to `in_progress` now claims too, so both are acceptable — a
		// move to any OTHER state is not.
		{
			input: `I'm going to start working on error issue ${FIXTURES.issueId}. Pick it up so nobody else duplicates the work.`,
			expectedTools: [{ name: "claim_error_issue", arguments: { issue_id: FIXTURES.issueId } }],
		},
		// "Is anyone on this?" is a read, not a claim — the opposite failure mode.
		// The timeline is the right read: a claim is an event on it, and it names
		// the actor. (This case originally expected `list_error_issues`; the model
		// chose the events tool, which is the better answer, so the expectation
		// moved rather than the model.)
		{
			input: `Is anyone currently working on error issue ${FIXTURES.issueId}?`,
			expectedTools: [{ name: "list_error_issue_events", arguments: { issue_id: FIXTURES.issueId } }],
		},
		// A fix with a PR goes through propose_fix, which claims and moves the
		// issue in one call. The model must NOT hand-walk the state machine first.
		{
			input: `I fixed error issue ${FIXTURES.issueId} — the PR is https://github.com/acme/api/pull/42. Record the fix.`,
			expectedTools: [
				{
					name: "propose_fix",
					arguments: {
						issue_id: FIXTURES.issueId,
						pr_url: "https://github.com/acme/api/pull/42",
					},
				},
			],
		},
		// A PR that already exists and is not being proposed as new work.
		{
			input: `PR https://github.com/acme/api/pull/99 already covers error issue ${FIXTURES.issueId}. Attach it so the fix gets verified after it merges.`,
			expectedTools: [
				{
					name: "link_pull_request",
					arguments: {
						issue_id: FIXTURES.issueId,
						pull_request_url: "https://github.com/acme/api/pull/99",
					},
				},
			],
		},
		// Handing work back is its own tool, not a transition.
		{
			input: `I'm done looking at error issue ${FIXTURES.issueId} and didn't get anywhere. Let someone else take it.`,
			expectedTools: [{ name: "release_error_issue", arguments: { issue_id: FIXTURES.issueId } }],
		},
	],
	task: predictToolCalls,
	scorers: [ToolCallScorer({ params: "fuzzy" })],
	threshold: 0.7,
})
