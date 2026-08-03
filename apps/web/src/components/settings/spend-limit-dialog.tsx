import { useState } from "react"
import { Cause, Exit } from "effect"
import { toastManager } from "@maple/ui/components/ui/toast"

import { SpendLimits, UpdateSpendLimitsRequest, type SpendEnforcementMode } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import {
	Dialog,
	DialogClose,
	DialogFooter,
	DialogHeader,
	DialogPopup,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Radio, RadioGroup } from "@maple/ui/components/ui/radio-group"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { cn } from "@maple/ui/lib/utils"

import { useAtomSet } from "@/lib/effect-atom"
import { BILLING_SPEND_LIMITS_KEY, updateSpendLimitsMutation } from "@/lib/services/atoms/billing-atoms"
import { formatCurrency } from "@/lib/billing/currency"
import { featureUnit, FEATURE_LABELS, type SpendFeatureId, type SpendModel } from "@/lib/billing/spend"

/**
 * The spend-limit editor.
 *
 * Editing is a dialog, not inline fields on the card: these three settings only
 * make sense committed together (a threshold above a limit that no longer exists,
 * or "pause" saved before its ceiling, are states nobody chose), and the card
 * itself is something people read far more often than they change.
 */

/**
 * The composed money/volume field: the *container* is the frame (so the `$`
 * prefix and the "per billing cycle" suffix sit inside it, as in the design), and
 * the input itself is bare. `Input` can't be used here — it renders its own
 * bordered wrapper plus a `before:` hairline that className can't reach, which
 * shows up as a second box drawn inside the field.
 */
const FIELD_SHELL =
	"flex items-center gap-2 rounded-md border border-border/70 bg-background px-3.5 py-2.5 transition-colors focus-within:border-primary"
const FIELD_INPUT =
	"min-w-0 grow bg-transparent font-mono text-base text-foreground tabular-nums outline-none placeholder:font-sans placeholder:text-muted-foreground/60"

/** Offered thresholds. Anything else goes through "Custom…". */
const PRESET_THRESHOLDS = [50, 80, 100] as const

const MODE_COPY: Record<SpendEnforcementMode, { title: string; detail: string }> = {
	notify: {
		detail: "Keep ingesting. Overage keeps accruing at plan rates.",
		title: "Notify only",
	},
	pause: {
		detail: "Capped features are rejected at the gateway (HTTP 402) until the cycle resets or the limit is raised. SDKs retry safely.",
		title: "Pause ingest at limit",
	},
}

const centsToInput = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2))

const parseDollarsToCents = (raw: string): number | null => {
	const trimmed = raw.trim()
	if (trimmed === "") return null
	const value = Number(trimmed)
	if (!Number.isFinite(value) || value <= 0) return null
	return Math.round(value * 100)
}

const parseThresholdList = (raw: string): ReadonlyArray<number> =>
	Array.from(
		new Set(
			raw
				.split(",")
				.map((part) => Number(part.trim()))
				.filter((value) => Number.isFinite(value) && value > 0 && value <= 100),
		),
	).sort((a, b) => a - b)

/** Amber pill for a selected threshold; quiet outline when not. */
function ThresholdChip({
	label,
	selected,
	dashed,
	onClick,
}: {
	label: string
	selected: boolean
	dashed?: boolean
	onClick: () => void
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"rounded-full border px-3 py-1 font-mono text-xs transition-colors",
				dashed && "border-dashed font-sans",
				selected
					? "border-primary/45 bg-primary/10 text-primary"
					: "border-border/70 text-muted-foreground hover:text-foreground",
			)}
		>
			{label}
		</button>
	)
}

export function SpendLimitDialog({
	open,
	onOpenChange,
	limits,
	model,
	lastCycleTotal,
	/** Pre-seed a cap edit instead of the org limit — the per-row "Edit" affordance. */
	capFeature,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	limits: SpendLimits
	model: SpendModel | null
	/** Total of the most recent closed invoice, for the "last cycle closed at" line. */
	lastCycleTotal: number | null
	capFeature?: SpendFeatureId
}) {
	const save = useAtomSet(updateSpendLimitsMutation, { mode: "promiseExit" })
	const [saving, setSaving] = useState(false)

	const [limitInput, setLimitInput] = useState(centsToInput(limits.monthlyLimitCents))
	const [mode, setMode] = useState<SpendEnforcementMode>(limits.enforcementMode)
	const [thresholds, setThresholds] = useState<ReadonlyArray<number>>(limits.alertThresholdPercents)
	const [customOpen, setCustomOpen] = useState(
		limits.alertThresholdPercents.some(
			(percent) => !PRESET_THRESHOLDS.includes(percent as (typeof PRESET_THRESHOLDS)[number]),
		),
	)
	const [customInput, setCustomInput] = useState(
		limits.alertThresholdPercents
			.filter((p) => !PRESET_THRESHOLDS.includes(p as (typeof PRESET_THRESHOLDS)[number]))
			.join(", "),
	)
	const [capInput, setCapInput] = useState(
		capFeature
			? limits.featureCaps[capFeature] == null
				? ""
				: String(limits.featureCaps[capFeature])
			: "",
	)

	const editingCap = capFeature !== undefined
	const limitCents = parseDollarsToCents(limitInput)

	const toggleThreshold = (percent: number) =>
		setThresholds((current) =>
			current.includes(percent)
				? current.filter((value) => value !== percent)
				: [...current, percent].sort((a, b) => a - b),
		)

	async function handleSave() {
		const merged = customOpen
			? Array.from(new Set([...thresholds, ...parseThresholdList(customInput)])).sort((a, b) => a - b)
			: thresholds

		const featureCaps: Record<string, number | null> = { ...limits.featureCaps }
		if (editingCap) {
			const parsed = Number(capInput.trim())
			featureCaps[capFeature] =
				capInput.trim() === "" || !Number.isFinite(parsed) || parsed <= 0 ? null : parsed
		}

		setSaving(true)
		const exit = await save({
			payload: new UpdateSpendLimitsRequest({
				monthlyLimitCents: limitCents,
				enforcementMode: mode,
				alertThresholdPercents: merged.length > 0 ? merged : [80, 100],
				featureCaps,
			}),
			reactivityKeys: [BILLING_SPEND_LIMITS_KEY],
		})
		setSaving(false)

		if (Exit.isSuccess(exit)) {
			toastManager.add({ title: editingCap ? "Cap saved." : "Spend limit saved.", type: "success" })
			onOpenChange(false)
			return
		}
		// Server-side validation is the authority here (it also guards the API and
		// the cron), so surface its message rather than pre-empting it client-side.
		const error = Cause.squash(exit.cause)
		toastManager.add({
			title: error instanceof Error ? error.message : "Couldn't save spend limits.",
			type: "error",
		})
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogPopup className="w-[480px] max-w-[calc(100vw-2rem)] gap-0 p-0">
				<DialogHeader className="px-5 pt-[18px] pb-0">
					<DialogTitle className="text-[17px] tracking-tight">
						{editingCap ? `Edit ${FEATURE_LABELS[capFeature]} cap` : "Edit spend limit"}
					</DialogTitle>
				</DialogHeader>

				{editingCap ? (
					<div className="flex flex-col gap-1.5 px-5 pt-[18px]">
						<Label htmlFor="cap-value" className="text-xs font-medium text-muted-foreground">
							Cap per cycle
						</Label>
						<div className={FIELD_SHELL}>
							<input
								id="cap-value"
								inputMode="decimal"
								placeholder="No cap"
								value={capInput}
								onChange={(event) => setCapInput(event.target.value)}
								className={FIELD_INPUT}
							/>
							<span className="text-[11px] text-muted-foreground/80">
								{featureUnit(capFeature)} per billing cycle
							</span>
						</div>
						<p className="text-[11px] leading-4 text-muted-foreground/80">
							Leave empty for no cap — overage stays billed at the plan rate. A cap only stops
							its own signal, and only when the limit is set to pause ingest.
						</p>
					</div>
				) : (
					<div className="flex flex-col gap-1.5 px-5 pt-[18px]">
						<Label htmlFor="monthly-limit" className="text-xs font-medium text-muted-foreground">
							Monthly limit
						</Label>
						<div className={FIELD_SHELL}>
							<span className="font-mono text-base text-muted-foreground/80">$</span>
							<input
								id="monthly-limit"
								inputMode="decimal"
								placeholder="No limit"
								value={limitInput}
								onChange={(event) => setLimitInput(event.target.value)}
								className={FIELD_INPUT}
							/>
							<span className="shrink-0 text-[11px] text-muted-foreground/80">
								per billing cycle
							</span>
						</div>
						<p className="text-[11px] leading-4 text-muted-foreground/80">
							{model
								? `Current pace projects ${formatCurrency(model.projectedCents / 100, model.currency)} this cycle.`
								: "Set a ceiling on estimated spend for this org."}
							{lastCycleTotal !== null &&
								` Last cycle closed at ${formatCurrency(lastCycleTotal, model?.currency ?? "usd")}.`}
						</p>
					</div>
				)}

				{!editingCap && (
					<>
						<div className="flex flex-col gap-2 px-5 pt-[18px]">
							<span className="text-xs font-medium text-muted-foreground">Alert me at</span>
							<div className="flex flex-wrap gap-2">
								{PRESET_THRESHOLDS.map((percent) => (
									<ThresholdChip
										key={percent}
										label={`${percent}%`}
										selected={thresholds.includes(percent)}
										onClick={() => toggleThreshold(percent)}
									/>
								))}
								<ThresholdChip
									label="Custom…"
									dashed
									selected={customOpen}
									onClick={() => setCustomOpen((value) => !value)}
								/>
							</div>
							{customOpen && (
								<Input
									inputMode="numeric"
									placeholder="e.g. 25, 60"
									value={customInput}
									onChange={(event) => setCustomInput(event.target.value)}
									aria-label="Custom alert thresholds, in percent"
									className="mt-1 h-8 w-40 font-mono text-xs tabular-nums"
								/>
							)}
						</div>

						<div className="flex flex-col gap-2 px-5 pt-[18px]">
							<span className="text-xs font-medium text-muted-foreground">
								When the limit is reached
							</span>
							<RadioGroup
								value={mode}
								onValueChange={(value) => setMode(value as SpendEnforcementMode)}
								className="gap-2"
							>
								{(["notify", "pause"] as const).map((value) => (
									<Label
										key={value}
										className={cn(
											"flex cursor-pointer items-start gap-2.5 rounded-md border p-3.5 transition-colors",
											mode === value
												? "border-primary/45 bg-primary/[0.06]"
												: "border-border/70 hover:border-border",
										)}
									>
										<Radio value={value} className="mt-0.5" />
										<span className="flex flex-col gap-0.5">
											<span className="text-sm font-medium">
												{MODE_COPY[value].title}
											</span>
											<span className="text-[11px] leading-4 text-muted-foreground">
												{MODE_COPY[value].detail}
											</span>
										</span>
									</Label>
								))}
							</RadioGroup>
						</div>
					</>
				)}

				<DialogFooter className="px-5 pt-[18px] pb-5">
					<DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
					<Button size="sm" onClick={handleSave} disabled={saving}>
						{saving ? <Spinner className="size-4" /> : editingCap ? "Save cap" : "Save limit"}
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	)
}
