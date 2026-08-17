import type { ReactNode } from "react"
import type { V2Investigation } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"
import { toEpochMs } from "@maple/ui/lib/time-format"

import { SEVERITY_LABEL } from "@/components/errors/severity-badge"
import { CheckIcon, CircleQuestionIcon, CircleXmarkIcon } from "@/components/icons"
import { useTickingNow } from "@/hooks/use-ticking-now"
import { type Elapsed, splitDuration } from "./investigation-display"
import { ConfidenceMeter } from "./confidence-meter"
import { lensCopy } from "./lens-catalogue"
import { type LensRun, hasFanout, lensTally } from "./lens-derive"

/**
 * What the investigation concluded, or how far it has got trying. One card, four
 * shapes — diagnosed, running, inconclusive, failed — because they answer the
 * same question at different stages and swapping between them shouldn't move the
 * page around.
 *
 * The left edge is a 3px accent rule, so the card is square on that side: a
 * rounded corner behind a flat bar leaves a sliver of card showing above and
 * below the rule, which reads as a rendering bug.
 */
export function VerdictCard({ investigation }: { investigation: V2Investigation }) {
	if (investigation.status === "investigating") {
		return <InvestigatingVerdict investigation={investigation} />
	}
	// Before the `failed` check. These are different claims: `inconclusive` means
	// the run worked and reached "not established", `failed` means the machinery
	// broke. Rendering the first as the second is what put a raw
	// `validation_inconclusive: …` string in a destructive box on top of a run
	// that had ruled things out perfectly well.
	if (investigation.status === "inconclusive") {
		return <InconclusiveVerdict investigation={investigation} />
	}
	if (investigation.status === "failed") {
		return <FailedVerdict investigation={investigation} />
	}
	return <DiagnosedVerdict investigation={investigation} />
}

/* -------------------------------------------------------------------------------------------------
 * Shell
 * -----------------------------------------------------------------------------------------------*/

function VerdictShell({
	accent,
	children,
	stats,
}: {
	accent: string
	children: ReactNode
	stats: ReactNode
}) {
	return (
		// `shrink-0`: the page column is `min-h-full`, so without it a tall card is
		// the flex item that absorbs the shortfall and collapses to its borders
		// while its content overflows into the section below.
		// Square on whichever edge carries the accent rule — a rounded corner behind
		// a flat bar leaves a sliver of card showing past it, which reads as a
		// rendering bug. That edge is the left when the card is a row, the top once
		// it stacks.
		<div className="flex shrink-0 overflow-hidden rounded-r-xl border bg-card max-lg:flex-col max-lg:rounded-b-xl max-lg:rounded-tr-none">
			{/* The accent rule runs the full height as a column edge, but once the
			    card stacks it has to become a top edge or it caps the card at 3px. */}
			<span aria-hidden className={cn("w-[3px] shrink-0 max-lg:h-[3px] max-lg:w-full", accent)} />
			<div className="flex min-w-0 flex-1 flex-col gap-3 px-7 py-6">{children}</div>
			{/* Stacked below `lg` rather than hidden: confidence and AI severity are
			    the two things that qualify the verdict, and dropping them on a narrow
			    window leaves an unqualified claim. */}
			<div className="flex w-53 shrink-0 flex-col border-l max-lg:w-full max-lg:flex-row max-lg:flex-wrap max-lg:border-l-0 max-lg:border-t">
				{stats}
			</div>
		</div>
	)
}

function Stat({ label, children, last }: { label: string; children: ReactNode; last?: boolean }) {
	return (
		<div
			className={cn(
				"flex flex-col gap-2 px-6 py-5.5 max-lg:min-w-40 max-lg:flex-1 max-lg:border-b-0 max-lg:py-4",
				last ? null : "border-b max-lg:border-r",
			)}
		>
			<span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				{label}
			</span>
			<div className="text-sm">{children}</div>
		</div>
	)
}

/** A big number with a small unit riding its baseline. */
function BigStat({ value, unit }: { value: string; unit: string }) {
	return (
		<span className="flex items-baseline gap-1">
			<span className="font-display text-2xl font-semibold tracking-tight text-foreground tabular-nums">
				{value}
			</span>
			<span className="text-sm text-muted-foreground">{unit}</span>
		</span>
	)
}

function Eyebrow({ children, tone }: { children: ReactNode; tone: string }) {
	return (
		<div
			className={cn(
				"flex flex-wrap items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em]",
				tone,
			)}
		>
			{children}
		</div>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Diagnosed
 * -----------------------------------------------------------------------------------------------*/

function DiagnosedVerdict({ investigation }: { investigation: V2Investigation }) {
	const report = investigation.report
	const promoted = hasFanout(investigation)
		? investigation.lens_runs.find((lens) => lens.verdict === "promoted")
		: undefined

	if (!report) {
		return (
			<VerdictShell
				accent="bg-border"
				stats={
					<Stat label="Confidence" last>
						<ConfidenceMeter confidence={investigation.confidence} />
					</Stat>
				}
			>
				<Eyebrow tone="text-muted-foreground">No diagnosis recorded</Eyebrow>
				<p className="text-sm text-muted-foreground">
					The pass finished without attaching a report. Run it again to try for a cause.
				</p>
			</VerdictShell>
		)
	}

	const timeToDiagnosis = elapsedBetween(investigation.created_at, investigation.diagnosed_at)

	return (
		<VerdictShell
			accent="bg-primary"
			stats={
				<>
					<Stat label="Confidence">
						<ConfidenceMeter confidence={report.confidence} />
					</Stat>
					<Stat label="AI severity">
						<span className={cn("font-medium", SEVERITY_TEXT_TONE[report.severityAssessment])}>
							{SEVERITY_LABEL[report.severityAssessment]}
						</span>
					</Stat>
					<Stat label="Time to diagnosis" last>
						{timeToDiagnosis ? (
							<BigStat value={timeToDiagnosis.value} unit={timeToDiagnosis.unit} />
						) : (
							<span className="text-muted-foreground">—</span>
						)}
					</Stat>
				</>
			}
		>
			<Eyebrow tone="text-primary">
				Suspected cause
				{promoted ? (
					<>
						<span aria-hidden className="text-muted-foreground/40">
							·
						</span>
						<span className="flex items-center gap-1 rounded-sm bg-success/12 px-1.5 py-0.5 text-success">
							<CheckIcon size={9} />
							Validated
						</span>
						{/*
							Quoted verbatim, not lowercased into a sentence. That read fine
							against a four-word catalogue label ("the deploy correlation
							lens"); a planner writes "The 14:02 payments-api rollout", and
							"promoted from the the 14:02 payments-api rollout lens" is not a
							sentence at all.
						*/}
						<span className="normal-case tracking-normal text-muted-foreground">
							promoted from “{lensCopy(promoted).name}”
						</span>
					</>
				) : null}
			</Eyebrow>
			<h2 className="font-display text-xl font-semibold leading-7 tracking-[-0.01em] text-foreground">
				{report.suspectedCause}
			</h2>
			<p className="text-sm leading-6 text-muted-foreground">{report.summary}</p>
		</VerdictShell>
	)
}

/** The badge tones are backgrounds; the stat column wants the text colour alone. */
const SEVERITY_TEXT_TONE: Record<string, string> = {
	critical: "text-destructive",
	high: "text-destructive",
	medium: "text-severity-warn",
	low: "text-muted-foreground",
	unclassified: "text-muted-foreground",
} satisfies Record<string, string>

/* -------------------------------------------------------------------------------------------------
 * Investigating
 * -----------------------------------------------------------------------------------------------*/

const COUNT_WORD = ["No", "One", "Two", "Three", "Four", "Five"] as const
const countWord = (n: number) => COUNT_WORD[n] ?? String(n)

function InvestigatingVerdict({ investigation }: { investigation: V2Investigation }) {
	const lenses = investigation.lens_runs
	const tally = lensTally(lenses)
	const validator = investigation.validator
	const fanned = hasFanout(investigation)

	return (
		<VerdictShell
			accent="bg-primary"
			stats={
				<>
					<Stat label="Elapsed">
						<LiveElapsedStat from={investigation.created_at} />
					</Stat>
					{fanned ? (
						<Stat label="Lenses reported">
							<span className="text-foreground tabular-nums">
								{tally.reported} of {tally.total}
							</span>
						</Stat>
					) : null}
					{validator ? (
						<Stat label="Validation">
							<span className="text-foreground">Blocked</span>
						</Stat>
					) : null}
					<Stat label="Confidence" last>
						<span className="text-muted-foreground">Pending</span>
					</Stat>
				</>
			}
		>
			<Eyebrow tone="text-primary">
				<span className="flex items-center gap-1.5">
					<span aria-hidden className="size-1.5 animate-pulse rounded-full bg-primary" />
					Investigating
				</span>
				{fanned ? (
					<>
						<span aria-hidden className="text-muted-foreground/40">
							·
						</span>
						<span>{tally.total} lenses in flight</span>
					</>
				) : null}
			</Eyebrow>
			<h2 className="font-display text-xl font-semibold leading-7 tracking-[-0.01em] text-foreground">
				{fanned
					? `${countWord(tally.total)} agents are attacking this from different angles. ${countWord(tally.reported)} ${tally.reported === 1 ? "has" : "have"} reported.`
					: "Maple is gathering evidence."}
			</h2>
			{fanned ? (
				<LensLanes lenses={lenses} validator={validator} />
			) : (
				<p className="text-sm leading-6 text-muted-foreground">
					One agent is working this question. The transcript shows what it is doing as it goes.
				</p>
			)}
		</VerdictShell>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Failed
 * -----------------------------------------------------------------------------------------------*/

function FailedVerdict({ investigation }: { investigation: V2Investigation }) {
	const lenses = investigation.lens_runs
	const tally = lensTally(lenses)
	const fanned = hasFanout(investigation)
	const validator = investigation.validator
	// From `started_at`, not `created_at`: a restart re-stamps the former, and
	// measuring from the latter reported a 20-day-old investigation as a
	// 480-hour run.
	const ranFor = elapsedBetween(
		investigation.started_at ?? investigation.created_at,
		investigation.updated_at,
	)
	// A fan-out can fail two ways, and they are not the same claim. The validator
	// ranking every candidate down is a *finding*. Dying before the validator ran
	// — a stalled workflow swept by the timeout — is not, and saying "rejected
	// every candidate" there states a ruling nobody made, beside a validator lane
	// that still reads "blocked" and a `diagnosis_timeout` error box.
	const rejectedAll = fanned && validator?.status === "rejected_all"

	return (
		<VerdictShell
			accent="bg-destructive"
			stats={
				<>
					<Stat label="Ran for">
						{ranFor ? (
							<BigStat value={ranFor.value} unit={ranFor.unit} />
						) : (
							<span className="text-muted-foreground">—</span>
						)}
					</Stat>
					{fanned ? (
						<Stat label="Lenses reported">
							<span className="text-foreground tabular-nums">
								{tally.reported} of {tally.total}
							</span>
						</Stat>
					) : null}
					<Stat label="Validation">
						<span className="text-foreground">
							{rejectedAll ? "Rejected all" : fanned ? "Never ran" : "None"}
						</span>
					</Stat>
					<Stat label="Confidence" last>
						<span className="text-muted-foreground">None</span>
					</Stat>
				</>
			}
		>
			<Eyebrow tone="text-destructive">
				No diagnosis
				{rejectedAll ? (
					<>
						<span aria-hidden className="text-muted-foreground/40">
							·
						</span>
						<span>Validator rejected every candidate</span>
					</>
				) : null}
			</Eyebrow>
			<h2 className="font-display text-xl font-semibold leading-7 tracking-[-0.01em] text-foreground">
				{rejectedAll
					? `${countWord(tally.reported)} ${tally.reported === 1 ? "lens" : "lenses"} reported, and none of them held up`
					: fanned
						? "The fan-out ended before the validator could rank it"
						: "The pass ended without a diagnosis"}
			</h2>
			<p className="text-sm leading-6 text-muted-foreground">
				{rejectedAll
					? "The candidates contradicted each other, so Maple promoted nothing rather than guess. What each lens did gather is kept below — a retry re-runs the fan-out with a wider evidence budget."
					: fanned
						? "Whatever the lenses gathered is kept below, but nothing ranked them. A retry re-runs the fan-out."
						: "Nothing was promoted. Retry to run the pass again."}
			</p>
			{/* The raw error was on the wire and rendered nowhere but a toast. */}
			{investigation.error ? (
				<div className="flex items-start gap-3 rounded-lg border border-destructive/25 bg-destructive/6 px-3 py-2.5">
					<span className="shrink-0 rounded-sm bg-destructive/12 px-1.5 py-0.5 font-mono text-[11px] text-destructive">
						reason
					</span>
					<code className="min-w-0 break-words font-mono text-xs leading-5 text-foreground">
						{investigation.error}
					</code>
				</div>
			) : null}
			{fanned ? <LensLanes lenses={lenses} validator={validator} /> : null}
		</VerdictShell>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Inconclusive
 * -----------------------------------------------------------------------------------------------*/

/** Above this the lists collapse; the rest is one click away on the Hypotheses tab. */
const PARTIAL_VISIBLE_MAX = 5

/**
 * A run that reached "not established", published as a result rather than as an
 * error.
 *
 * The editorial call that matters most is the h2: the page still leads with a
 * *sentence about the incident* — the strongest remaining lead — rather than
 * with "we could not tell". Someone opening this has an open incident, and what
 * they need first is the lead and then the list of things no longer worth their
 * time. The failed card's raw `reason` box is deliberately absent: `error` is
 * null on these rows now, and the payload that replaced it is `ruledOut` /
 * `unchecked`.
 */
function InconclusiveVerdict({ investigation }: { investigation: V2Investigation }) {
	const lenses = investigation.lens_runs
	const tally = lensTally(lenses)
	const validator = investigation.validator
	const fanned = hasFanout(investigation)
	const report = investigation.report
	// From `started_at` for the same reason the failed card is: a restart
	// re-stamps it, and measuring from `created_at` reports a 20-day-old
	// investigation as a 480-hour run.
	const ranFor = elapsedBetween(
		investigation.started_at ?? investigation.created_at,
		investigation.updated_at,
	)
	const ruledOut = report?.ruledOut ?? []
	const unchecked = report?.unchecked ?? []
	// Legacy rows backfilled to `inconclusive` have no report at all. The
	// validator's note is the only sentence they carry.
	const headline =
		report?.suspectedCause ??
		validator?.note ??
		"No cause was established, and this run recorded no partial."

	return (
		<VerdictShell
			// Warn, never destructive. Nothing broke — and the accent is the first
			// thing read, so it sets whether the whole card is a result or a defect.
			accent="bg-severity-warn"
			stats={
				<>
					<Stat label="Ran for">
						{ranFor ? (
							<BigStat value={ranFor.value} unit={ranFor.unit} />
						) : (
							<span className="text-muted-foreground">—</span>
						)}
					</Stat>
					{fanned ? (
						<Stat label="Lenses reported">
							<span className="text-foreground tabular-nums">
								{tally.reported} of {tally.total}
							</span>
						</Stat>
					) : null}
					{/* Replaces the failed card's "Validation: Rejected all", which said
					    the same thing in a way that sounded like a defect. What was
					    eliminated is the run's actual output, so it gets the stat. */}
					<Stat label="Ruled out">
						<span className="text-foreground tabular-nums">{ruledOut.length}</span>
					</Stat>
					<Stat label="Confidence" last>
						{/* A low-confidence lead is a real thing and the meter is the
						    component that says so. The word "None" would claim the run
						    produced nothing, which is the framing being removed. */}
						{report ? (
							<ConfidenceMeter confidence="low" />
						) : (
							<span className="text-muted-foreground">—</span>
						)}
					</Stat>
				</>
			}
		>
			<Eyebrow tone="text-severity-warn">
				Partial result
				<span aria-hidden className="text-muted-foreground/40">
					·
				</span>
				<span>Nothing promoted</span>
				{fanned ? (
					<>
						<span aria-hidden className="text-muted-foreground/40">
							·
						</span>
						<span className="normal-case tracking-normal text-muted-foreground">
							{tally.reported} of {tally.total} lenses reported
						</span>
					</>
				) : null}
			</Eyebrow>
			<h2 className="font-display text-xl font-semibold leading-7 tracking-[-0.01em] text-foreground">
				{headline}
			</h2>
			{report ? <p className="text-sm leading-6 text-muted-foreground">{report.summary}</p> : null}

			{/* Two columns above `lg`, stacked below — the shell's own breakpoint, so
			    the lists reflow with the stat rail rather than against it. */}
			{ruledOut.length > 0 || unchecked.length > 0 ? (
				<div className="mt-1 grid gap-x-8 gap-y-5 lg:grid-cols-2">
					<PartialList
						label="Ruled out"
						items={ruledOut}
						icon={
							<CircleXmarkIcon size={13} className="mt-0.5 shrink-0 text-muted-foreground/70" />
						}
						// Not struck through. These are conclusions the run reached, which
						// is the opposite of the dead lanes the failed card strikes out.
						tone="text-foreground"
					/>
					<PartialList
						label="Could not check"
						items={unchecked}
						icon={
							<CircleQuestionIcon
								size={13}
								className="mt-0.5 shrink-0 text-muted-foreground/70"
							/>
						}
						tone="text-muted-foreground"
					/>
				</div>
			) : null}

			{fanned ? <LensLanes lenses={lenses} validator={validator} /> : null}
		</VerdictShell>
	)
}

function PartialList({
	label,
	items,
	icon,
	tone,
}: {
	label: string
	items: ReadonlyArray<string>
	icon: ReactNode
	tone: string
}) {
	if (items.length === 0) return null
	const visible = items.slice(0, PARTIAL_VISIBLE_MAX)
	const hidden = items.length - visible.length
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				{label}
			</span>
			<ul className="flex flex-col gap-1.5">
				{visible.map((item) => (
					<li key={item} className={cn("flex gap-2 text-sm leading-6", tone)}>
						{icon}
						<span className="min-w-0">{item}</span>
					</li>
				))}
			</ul>
			{hidden > 0 ? (
				<span className="text-xs text-muted-foreground">+{hidden} more on the Hypotheses tab</span>
			) : null}
		</div>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Lens lanes
 * -----------------------------------------------------------------------------------------------*/

const LANE_DOT: Record<LensRun["status"], string> = {
	reported: "bg-success",
	checking: "bg-primary animate-pulse",
	queued: "border border-muted-foreground/40",
	no_finding: "bg-muted-foreground/40",
} satisfies Record<LensRun["status"], string>

const LANE_NOTE: Record<LensRun["status"], string> = {
	reported: "reported a candidate",
	checking: "checking",
	queued: "queued",
	no_finding: "no finding",
} satisfies Record<LensRun["status"], string>

/**
 * One row per dispatched lens: where it got to, what it claimed, how long it
 * took. On a failed run the claims are struck through — they were reported and
 * then rejected, which is different from never having been made.
 */
function LensLanes({
	lenses,
	validator,
}: {
	lenses: ReadonlyArray<LensRun>
	validator: V2Investigation["validator"]
}) {
	// `flex-wrap` + a `min-w-*` floor on the claim: with the rail open and the
	// stat column showing, a fixed three-column lane crushes the claim to a
	// five-word-per-line ribbon. Below the floor the claim drops to its own line
	// at full width instead.
	return (
		<ul className="mt-1 flex flex-col">
			{lenses.map((entry) => (
				<li
					key={entry.lensId}
					className="flex flex-wrap items-start gap-x-4 gap-y-1 border-t py-3 first:border-t-0 first:pt-1"
				>
					<span
						aria-hidden
						className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", LANE_DOT[entry.status])}
					/>
					<span className="w-40 shrink-0">
						<span className="block text-sm text-foreground">{lensCopy(entry).name}</span>
						<span
							className={cn(
								"block text-xs",
								entry.status === "checking" ? "text-primary" : "text-muted-foreground",
							)}
						>
							{entry.progressNote ?? LANE_NOTE[entry.status]}
						</span>
					</span>
					<span
						className={cn(
							"min-w-56 flex-1 text-sm",
							entry.verdict === "rejected"
								? "text-muted-foreground line-through"
								: entry.claim
									? "text-muted-foreground"
									: "text-muted-foreground/70",
						)}
					>
						{entry.claim ?? entry.reason ?? "—"}
					</span>
					<span className="ml-auto w-12 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums">
						{entry.elapsedSeconds === null ? "—" : `${entry.elapsedSeconds.toFixed(1)}s`}
					</span>
				</li>
			))}
			{validator ? (
				<li className="flex flex-wrap items-start gap-x-4 gap-y-1 border-t py-3">
					<span
						aria-hidden
						className={cn(
							"mt-1.5 size-1.5 shrink-0 rounded-full",
							validator.status === "blocked"
								? "border border-muted-foreground/40"
								: validator.status === "rejected_all"
									? "bg-destructive"
									: "bg-success",
						)}
					/>
					<span className="w-40 shrink-0">
						<span
							className={cn(
								"block text-sm",
								validator.status === "rejected_all" ? "text-destructive" : "text-foreground",
							)}
						>
							Validator
						</span>
						<span className="block text-xs text-muted-foreground">
							{validator.status === "blocked"
								? "blocked"
								: validator.status === "rejected_all"
									? "rejected all"
									: "ranked"}
						</span>
					</span>
					<span className="min-w-56 flex-1 text-sm text-muted-foreground">{validator.note}</span>
					<span className="ml-auto w-12 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums">
						{validator.elapsedSeconds === null ? "—" : `${validator.elapsedSeconds.toFixed(1)}s`}
					</span>
				</li>
			) : null}
		</ul>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Elapsed helpers
 * -----------------------------------------------------------------------------------------------*/

function elapsedBetween(from: string, to: string | null): Elapsed | null {
	if (!to) return null
	const start = toEpochMs(from)
	const end = toEpochMs(to)
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
	return splitDuration(end - start)
}

/**
 * The one live number on the page. Its own component so the 1s tick re-renders
 * four characters rather than the whole verdict card — the card holds the lens
 * lanes, and rebuilding those every second is wasted work.
 */
function LiveElapsedStat({ from }: { from: string }) {
	const now = useTickingNow(true)
	const start = toEpochMs(from)
	if (!Number.isFinite(start)) return <span className="text-muted-foreground">—</span>
	const { value, unit } = splitDuration(Math.max(0, now - start))
	return <BigStat value={value} unit={unit} />
}
