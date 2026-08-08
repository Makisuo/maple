import { useState } from "react"
import { Cause, Exit } from "effect"

import type { BillingCustomer } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import {
	Dialog,
	DialogClose,
	DialogFooter,
	DialogHeader,
	DialogPopup,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Label } from "@maple/ui/components/ui/label"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { toastManager } from "@maple/ui/components/ui/toast"

import { useAtomSet } from "@/lib/effect-atom"
import { spendLimitFor, updateFeatureControls, usageAlertFor } from "@/lib/billing/controls"
import { featureUnit, FEATURE_LABELS, type SpendFeatureId } from "@/lib/billing/spend"
import { BILLING_CUSTOMER_KEY, updateBillingControlsMutation } from "@/lib/services/atoms/billing-atoms"

const FIELD =
	"h-8 min-w-0 rounded-md border border-input bg-background px-2.5 font-mono text-sm tabular-nums outline-none focus:border-ring"

export function BillingControlsDialog({
	customer,
	featureId,
	open,
	onOpenChange,
}: {
	readonly customer: BillingCustomer
	readonly featureId: SpendFeatureId
	readonly open: boolean
	readonly onOpenChange: (open: boolean) => void
}) {
	const existingLimit = spendLimitFor(customer, featureId)?.overageLimit
	const existingAlert = usageAlertFor(customer, featureId)
	const save = useAtomSet(updateBillingControlsMutation, { mode: "promiseExit" })
	const [limit, setLimit] = useState(existingLimit === undefined ? "" : String(existingLimit))
	const [alert, setAlert] = useState(
		existingAlert?.thresholdType === "usage_percentage" ? String(existingAlert.threshold) : "",
	)
	const [saving, setSaving] = useState(false)

	async function handleSave() {
		const overageLimit = limit.trim() === "" ? null : Number(limit)
		if (overageLimit !== null && (!Number.isFinite(overageLimit) || overageLimit < 0)) {
			toastManager.add({ title: "Paid overage cap must be zero or greater.", type: "error" })
			return
		}
		const alertPercent = alert.trim() === "" ? null : Number(alert)
		if (
			alertPercent !== null &&
			(!Number.isFinite(alertPercent) || alertPercent <= 0 || alertPercent > 100)
		) {
			toastManager.add({ title: "Alert threshold must be between 1% and 100%.", type: "error" })
			return
		}

		setSaving(true)
		const exit = await save({
			payload: updateFeatureControls({ customer, featureId, overageLimit, alertPercent }),
			reactivityKeys: [BILLING_CUSTOMER_KEY],
		})
		setSaving(false)

		if (Exit.isSuccess(exit)) {
			toastManager.add({ title: `${FEATURE_LABELS[featureId]} controls saved.`, type: "success" })
			onOpenChange(false)
			return
		}
		const error = Cause.squash(exit.cause)
		toastManager.add({
			title: error instanceof Error ? error.message : "Billing controls could not be saved.",
			type: "error",
		})
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogPopup className="w-[440px] max-w-[calc(100vw-2rem)] gap-0 p-0">
				<DialogHeader className="px-5 pt-[18px] pb-0">
					<DialogTitle className="text-[17px] tracking-tight">
						{FEATURE_LABELS[featureId]} billing controls
					</DialogTitle>
				</DialogHeader>

				<div className="space-y-5 px-5 pt-[18px]">
					<div className="space-y-1.5">
						<Label htmlFor="overage-limit">Paid overage cap</Label>
						<div className="flex items-center gap-2">
							<input
								id="overage-limit"
								type="number"
								inputMode="decimal"
								min={0}
								step="any"
								value={limit}
								onChange={(event) => setLimit(event.target.value)}
								placeholder="No cap"
								className={FIELD}
							/>
							<span className="text-xs text-muted-foreground">
								{featureUnit(featureId)} beyond included / cycle
							</span>
						</div>
						<p className="text-[11px] leading-4 text-muted-foreground">
							Autumn rejects new usage for this feature after the included allowance plus this
							paid overage is consumed. Leave empty for uncapped overage.
						</p>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="usage-alert">Autumn webhook threshold</Label>
						<div className="flex items-center gap-2">
							<input
								id="usage-alert"
								type="number"
								inputMode="decimal"
								min={1}
								max={100}
								step="any"
								value={alert}
								onChange={(event) => setAlert(event.target.value)}
								placeholder="No alert"
								className={FIELD}
							/>
							<span className="text-xs text-muted-foreground">% of included allowance</span>
						</div>
						<p className="text-[11px] leading-4 text-muted-foreground">
							Autumn emits a usage-alert webhook when this percentage of the included allowance
							is crossed. It does not change the cap.
						</p>
					</div>
				</div>

				<DialogFooter className="px-5 pt-[18px] pb-5">
					<DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
					<Button size="sm" onClick={handleSave} disabled={saving}>
						{saving ? <Spinner className="size-4" /> : "Save controls"}
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	)
}
