import { Schema } from "effect"
import type { IssueSeverity } from "./errors"

/**
 * How long to wait after a fix merges before believing that silence means it
 * worked.
 *
 * The question this file answers is not "has the error stopped" — that is
 * trivially true one second after a merge — but "have we watched long enough
 * that stopping is evidence of anything". For an error firing 10k times a day,
 * ten quiet minutes is a strong signal. For one firing three times a week, ten
 * quiet minutes is no signal at all, and closing on it produces exactly the
 * false "fixed" that makes an auto-close feature untrustworthy.
 *
 * So the window is derived from the issue's own pre-merge rate — the time it
 * would have taken to accumulate {@link VERIFICATION_TARGET_OCCURRENCES} more
 * occurrences had nothing changed — and then clamped into a band chosen by
 * severity. The clamps are what keep the derivation honest at both ends: a
 * pathological burst cannot drive the window to seconds, and a rare critical
 * bug cannot leave an issue in limbo for a fortnight.
 */

/**
 * Occurrences the pre-merge rate should have produced across the window.
 *
 * Twenty, not one: a single expected occurrence means a coin-flip's worth of
 * evidence, and the verdict rests on absence. At twenty, silence from an
 * unchanged system is unlikely enough to be worth acting on, while the wait
 * stays short enough to be useful on anything that fires with real volume.
 */
export const VERIFICATION_TARGET_OCCURRENCES = 20

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

interface VerificationBand {
	readonly minMs: number
	readonly maxMs: number
}

/**
 * Per-severity floor and ceiling on the window.
 *
 * Severity moves both ends, and for different reasons. The floor rises as
 * severity falls because there is no hurry to close a low-severity issue and a
 * longer look costs nothing. The ceiling falls as severity rises because a
 * critical issue left in `verifying` is a critical issue nobody is looking at —
 * better to reach an inconclusive verdict a human can act on within a day than
 * to wait out a fortnight for certainty.
 *
 * A null severity (untriaged) is treated as `low`: an issue nobody has ranked
 * is not one to close quickly.
 */
const BANDS = {
	critical: { minMs: 30 * MINUTE, maxMs: 1 * DAY },
	high: { minMs: 1 * HOUR, maxMs: 3 * DAY },
	medium: { minMs: 4 * HOUR, maxMs: 7 * DAY },
	low: { minMs: 12 * HOUR, maxMs: 14 * DAY },
} satisfies Record<IssueSeverity, VerificationBand>

export const verificationBandFor = (severity: IssueSeverity | null): VerificationBand =>
	BANDS[severity ?? "low"]

export interface VerificationWindowInput {
	readonly severity: IssueSeverity | null
	/**
	 * Occurrences per hour observed before the merge. Zero (or a rate too small to
	 * be meaningful) means the derivation has nothing to work with and the band
	 * ceiling applies — the safe direction, since a rare error needs the longest
	 * look.
	 */
	readonly ratePerHour: number
}

/**
 * The quiet window to wait before running verification, in milliseconds.
 *
 * Always inside the severity band, so callers never need to clamp again.
 */
export const verificationWindowMs = (input: VerificationWindowInput): number => {
	const band = verificationBandFor(input.severity)
	// A non-finite or non-positive rate carries no information about how long to
	// wait. `Number.isFinite` also rejects the NaN a 0/0 rate computation
	// produces upstream, which would otherwise sail through every comparison
	// below and return NaN as a timestamp offset.
	if (!Number.isFinite(input.ratePerHour) || input.ratePerHour <= 0) return band.maxMs
	const derivedMs = (VERIFICATION_TARGET_OCCURRENCES / input.ratePerHour) * HOUR
	return Math.min(band.maxMs, Math.max(band.minMs, Math.round(derivedMs)))
}

/**
 * Whether a `verified` verdict may close the issue on its own.
 *
 * High and critical issues get the verdict and the evidence posted to their
 * timeline, but a human makes the call. The asymmetry is deliberate: the cost of
 * a wrong auto-close scales with severity, while the value of saving a human the
 * click does not.
 */
export const verificationVerdictAutoCloses = (severity: IssueSeverity | null): boolean =>
	severity === null || severity === "low" || severity === "medium"

/**
 * How many inconclusive rounds a verification gets before it gives up and hands
 * the issue back. One retry with a longer window, then stop — a third round has
 * never changed a verdict that two could not reach, and an issue that keeps
 * re-arming never reaches a human.
 */
export const MAX_VERIFICATION_ATTEMPTS = 2

export const VerificationStatus = Schema.Literals([
	/** Window is running; nothing has been asked of an agent yet. */
	"waiting",
	/** A verification investigation is in flight. */
	"running",
	/** The fix holds. */
	"verified",
	/** The error fired from a build that postdates the merge. */
	"not_fixed",
	/** Not enough evidence either way. */
	"inconclusive",
	/** Out of attempts, or the issue moved on underneath it. */
	"abandoned",
]).annotate({
	identifier: "@maple/VerificationStatus",
	title: "Verification Status",
})
export type VerificationStatus = Schema.Schema.Type<typeof VerificationStatus>

export const VerificationVerdict = Schema.Literals(["verified", "not_fixed", "inconclusive"]).annotate({
	identifier: "@maple/VerificationVerdict",
	title: "Verification Verdict",
})
export type VerificationVerdict = Schema.Schema.Type<typeof VerificationVerdict>

export const PullRequestLinkState = Schema.Literals(["open", "merged", "closed"]).annotate({
	identifier: "@maple/PullRequestLinkState",
	title: "Pull Request Link State",
})
export type PullRequestLinkState = Schema.Schema.Type<typeof PullRequestLinkState>

/** Who attached the pull request — an agent's `propose_fix`, a person, or the webhook's body scan. */
export const PullRequestLinkSource = Schema.Literals(["agent", "user", "auto"]).annotate({
	identifier: "@maple/PullRequestLinkSource",
	title: "Pull Request Link Source",
})
export type PullRequestLinkSource = Schema.Schema.Type<typeof PullRequestLinkSource>
