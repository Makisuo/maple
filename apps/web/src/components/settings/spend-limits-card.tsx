import { useState } from "react"
import { Cause, Exit } from "effect"
import { toastManager } from "@maple/ui/components/ui/toast"
import { format } from "date-fns"

import { SpendLimits, UpdateSpendLimitsRequest, type SpendEnforcementMode } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import { cn } from "@maple/ui/lib/utils"

import { BellIcon } from "@/components/icons"
import { useAtomSet } from "@/lib/effect-atom"
import { BILLING_SPEND_LIMITS_KEY, updateSpendLimitsMutation } from "@/lib/services/atoms/billing-atoms"
import { formatCurrency } from "@/lib/billing/currency"
import {
	featureUnit,
	FEATURE_COLORS,
	SPEND_FEATURES,
	type SpendFeatureId,
	type SpendModel,
} from "@/lib/billing/spend"
import { formatCount } from "@/lib/billing/usage"
import { SpendLimitDialog } from "./spend-limit-dialog"

/**
 * Spend guardrails, read-first: the ceiling, what warns before it, what happens
 * at it, and the per-feature caps beneath. Everything editable opens the dialog
 * (see spend-limit-dialog.tsx) — the card is a statement of the current
 * configuration, which is what people come here to check.
 *
 * The enforcement toggle is the one exception: flipping between "notify" and
 * "pause" is a single, reversible decision, and burying it behind a dialog would
 * make the fastest way out of a pause the slowest.
 */

/**
 * A cap is a round number somebody typed, not a measurement: render `600 GB`,
 * not `600.00 GB`. Measured usage still goes through `formatUsage`, where the
 * decimals carry real information.
 */
const formatCap = (featureId: SpendFeatureId, value: number) =>
	featureUnit(featureId) === "GB"
		? `${Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(2)} GB`
		: formatCount(value)

export function SpendLimitsCardSkeleton() {
	return (
		<div className="border border-border/60 bg-card/40">
			<div className="flex items-center justify-between gap-6 px-5 py-[18px]">
				<div className="flex w-[340px] flex-col gap-1.5">
					<Skeleton className="h-4 w-40" />
					<Skeleton className="h-3 w-64" />
				</div>
				<Skeleton className="h-7 w-32" />
				<Skeleton className="h-8 w-56" />
			</div>
			<div className="border-t border-border/40 px-5 py-3">
				<Skeleton className="h-3 w-72" />
			</div>
		</div>
	)
}

export function SpendLimitsCard({
	limits,
	model,
	lastCycleTotal,
	canEdit,
}: {
	limits: SpendLimits
	model: SpendModel | null
	/** Most recent closed invoice total, shown in the edit dialog. */
	lastCycleTotal: number | null
	/** Only admins can change what the gateway enforces. */
	canEdit: boolean
}) {
	const save = useAtomSet(updateSpendLimitsMutation, { mode: "promiseExit" })
	const [switching, setSwitching] = useState(false)
	const [editing, setEditing] = useState<{ cap?: SpendFeatureId } | null>(null)

	const limitCents = limits.monthlyLimitCents
	/**
	 * Prefer the live model, but only when it can actually price the cycle: on a
	 * legacy plan it reports a partial $0, and pairing that with a breach the cron
	 * recorded reads as "limit reached · 0% used". The cron's figure is the number
	 * that tripped the limit, so it wins whenever the client can't price.
	 */
	const spendCents =
		model !== null && !model.partial
			? model.spendCents
			: (limits.evaluatedSpendCents ?? model?.spendCents ?? 0)
	const percentUsed = limitCents !== null && limitCents > 0 ? (spendCents / limitCents) * 100 : null
	const headroomCents = limitCents === null ? null : limitCents - spendCents
	const currency = model?.currency ?? "usd"
	const breached = limits.breachedAt !== null
	const paused = limits.pausedAt !== null
	const firstUncapped = SPEND_FEATURES.find((featureId) => limits.featureCaps[featureId] == null)

	/**
	 * Mode changes save immediately, carrying every other field through unchanged
	 * — the endpoint takes a full replace, so a partial payload here would quietly
	 * wipe the thresholds and caps the user set in the dialog.
	 */
	async function setMode(next: SpendEnforcementMode) {
		if (next === limits.enforcementMode) return
		setSwitching(true)
		const exit = await save({
			payload: new UpdateSpendLimitsRequest({
				monthlyLimitCents: limits.monthlyLimitCents,
				enforcementMode: next,
				alertThresholdPercents: limits.alertThresholdPercents,
				featureCaps: limits.featureCaps,
			}),
			reactivityKeys: [BILLING_SPEND_LIMITS_KEY],
		})
		setSwitching(false)
		if (Exit.isSuccess(exit)) {
			toastManager.add({
				title: next === "pause" ? "Ingest will pause at the limit." : "Switched to notify-only.",
				type: "success",
			})
			return
		}
		const error = Cause.squash(exit.cause)
		toastManager.add({
			title: error instanceof Error ? error.message : "Couldn't change enforcement.",
			type: "error",
		})
	}

	return (
		<>
			<div
				className={cn(
					"border bg-card/40",
					breached ? "border-severity-error/40 bg-severity-error/[0.03]" : "border-border/60",
				)}
			>
				{/* Header row: identity · figure · enforcement · edit */}
				<div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4 px-5 py-[18px]">
					<div className="flex w-[340px] shrink-0 flex-col gap-1">
						<div className="flex items-center gap-2">
							<span className="text-sm font-medium">Monthly spend limit</span>
							{breached && (
								<span className="rounded-full bg-severity-error/15 px-2 py-0.5 text-[10px] text-severity-error">
									Limit reached
								</span>
							)}
						</div>
						<p className="text-xs leading-[17px] text-muted-foreground">
							{paused
								? `Ingest is paused for capped features since ${format(new Date(limits.pausedAt as number), "MMM d, HH:mm")}. Uncapped features keep flowing.`
								: "Caps total estimated spend for the org. Alerts fire before any enforcement."}
						</p>
					</div>

					<div className="flex grow flex-col gap-1.5">
						{limitCents === null ? (
							<p className="text-sm text-muted-foreground">
								No limit set — overage is billed at plan rates.
							</p>
						) : (
							<>
								<div className="flex items-baseline gap-2">
									<span
										className={cn(
											"font-mono text-[22px] leading-7 tabular-nums",
											breached && "text-severity-error",
										)}
									>
										{formatCurrency(limitCents / 100, currency)}
									</span>
									<span className="text-xs text-muted-foreground">
										{breached
											? `of ${formatCurrency(limitCents / 100, currency)} · ${Math.round(percentUsed ?? 0)}% used`
											: headroomCents !== null
												? `per cycle · ${formatCurrency(Math.max(0, headroomCents) / 100, currency)} headroom`
												: "per cycle"}
									</span>
								</div>
								{breached && (
									<div className="h-[3px] w-full max-w-96 rounded-full bg-muted">
										<div
											className="h-full rounded-full bg-severity-error"
											style={{ width: `${Math.min(100, percentUsed ?? 100)}%` }}
										/>
									</div>
								)}
							</>
						)}
					</div>

					<div className="flex shrink-0 items-center gap-2.5">
						{breached ? (
							// In breach the two useful moves are explicit: more room, or
							// stop enforcing. A segmented control here would read as a
							// setting when it's really an escape hatch.
							<>
								<Button size="sm" onClick={() => setEditing({})} disabled={!canEdit}>
									Raise limit
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setMode("notify")}
									disabled={!canEdit || switching || limits.enforcementMode === "notify"}
								>
									Switch to notify-only
								</Button>
							</>
						) : (
							<>
								<ToggleGroup
									value={[limits.enforcementMode]}
									onValueChange={(values) => {
										const next = values[0]
										if (next === "notify" || next === "pause") void setMode(next)
									}}
									variant="outline"
									size="sm"
									disabled={!canEdit || switching}
									aria-label="What happens when the limit is reached"
								>
									<ToggleGroupItem value="notify">Notify only</ToggleGroupItem>
									<ToggleGroupItem value="pause">Pause ingest at limit</ToggleGroupItem>
								</ToggleGroup>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setEditing({})}
									disabled={!canEdit}
								>
									Edit
								</Button>
							</>
						)}
					</div>
				</div>

				{/* Alert row */}
				<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-border/40 px-5 py-3 text-xs text-muted-foreground">
					<BellIcon size={14} className="shrink-0 text-muted-foreground" />
					{limits.alertThresholdPercents.length === 0 || limitCents === null ? (
						<span>No spend alerts configured.</span>
					) : (
						<>
							<span>Alert at</span>
							{limits.alertThresholdPercents.map((percent, index) => (
								<span key={percent} className="flex items-center gap-2.5">
									<span className="font-mono font-medium text-foreground">{percent}%</span>
									{index < limits.alertThresholdPercents.length - 1 && <span>and</span>}
								</span>
							))}
							{/* Truthful about delivery: thresholds are evaluated hourly and
							    recorded, but routing them to Slack/email isn't wired yet. */}
							<span>· evaluated hourly</span>
						</>
					)}
				</div>

				{/* Per-feature caps */}
				<div className="flex flex-col border-t border-border/40">
					<div className="flex items-center justify-between px-5 pt-3 pb-2">
						<span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
							Per-feature caps
						</span>
						{/* Every feature is already listed, so this is a shortcut rather
						    than a new row: it opens the first one that has no cap. Hidden
						    once all four are capped, where it would do nothing. */}
						{firstUncapped !== undefined && canEdit && (
							<button
								type="button"
								onClick={() => setEditing({ cap: firstUncapped })}
								className="text-xs font-medium text-primary transition-colors hover:text-primary/80"
							>
								+ Add cap
							</button>
						)}
					</div>

					{SPEND_FEATURES.map((featureId, index) => {
						const feature = model?.features.find((entry) => entry.featureId === featureId)
						const cap = limits.featureCaps[featureId] ?? null
						const used = feature?.used ?? 0
						const capPercent = cap === null || cap <= 0 ? null : Math.min(100, (used / cap) * 100)
						const featurePaused = limits.pausedFeatures.includes(featureId)

						return (
							<div
								key={featureId}
								className={cn(
									"flex flex-wrap items-center gap-4 px-5 py-[11px]",
									index > 0 && "border-t border-border/25",
								)}
							>
								<div className="flex w-[200px] shrink-0 items-center gap-2">
									<span
										aria-hidden
										className="size-2 shrink-0 rounded-sm"
										style={{ background: FEATURE_COLORS[featureId] }}
									/>
									<span className="text-[13px]">{feature?.label ?? featureId}</span>
								</div>

								<span
									className={cn(
										"w-[140px] shrink-0 font-mono text-[13px] tabular-nums",
										cap === null && "text-muted-foreground/70",
									)}
								>
									{cap === null ? "No cap" : `${formatCap(featureId, cap)} / cycle`}
								</span>

								<div className="flex grow items-center gap-2.5">
									{capPercent === null ? (
										<span className="text-xs text-muted-foreground/70">
											Overage billed at plan rate
										</span>
									) : (
										<>
											<div className="h-[3px] w-40 shrink-0 overflow-hidden rounded-full bg-muted">
												<div
													className={cn(
														"h-full",
														featurePaused
															? "bg-severity-error"
															: "bg-[var(--cap-color)]",
													)}
													style={
														{
															"--cap-color": FEATURE_COLORS[featureId],
															width: `${capPercent}%`,
														} as React.CSSProperties
													}
												/>
											</div>
											<span className="font-mono text-xs tabular-nums text-muted-foreground">
												{Math.round(capPercent)}% used
											</span>
											{featurePaused && (
												<span className="text-xs text-severity-error">paused</span>
											)}
										</>
									)}
								</div>

								<button
									type="button"
									onClick={() => setEditing({ cap: featureId })}
									disabled={!canEdit}
									className="w-8 shrink-0 text-right text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
								>
									Edit
								</button>
							</div>
						)
					})}
				</div>
			</div>

			{editing !== null && (
				<SpendLimitDialog
					// Remount per target so the dialog's fields initialize from the row
					// being edited instead of whatever was opened first.
					key={editing.cap ?? "org"}
					open
					onOpenChange={(next) => {
						if (!next) setEditing(null)
					}}
					limits={limits}
					model={model}
					lastCycleTotal={lastCycleTotal}
					capFeature={editing.cap}
				/>
			)}
		</>
	)
}
