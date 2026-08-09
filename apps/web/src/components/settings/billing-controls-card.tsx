import { useState } from "react"

import type { BillingCustomer } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { maximumInvoiceCents, spendLimitFor, usageAlertFor } from "@/lib/billing/controls"
import { formatCurrency } from "@/lib/billing/currency"
import {
	featureUnit,
	FEATURE_COLORS,
	FEATURE_LABELS,
	SPEND_FEATURES,
	type SpendFeatureId,
	type SpendModel,
} from "@/lib/billing/spend"
import { formatCount, formatUsage } from "@/lib/billing/usage"
import { BillingControlsDialog } from "./billing-controls-dialog"

const formatUnits = (featureId: SpendFeatureId, value: number) =>
	featureUnit(featureId) === "GB" ? formatUsage(value) : formatCount(value)

export function BillingControlsCardSkeleton() {
	return (
		<div className="border border-border/60 bg-card/40">
			<div className="flex items-center justify-between px-5 py-4">
				<Skeleton className="h-4 w-64" />
				<Skeleton className="h-4 w-32" />
			</div>
			{SPEND_FEATURES.map((featureId) => (
				<div key={featureId} className="border-t border-border/40 px-5 py-3">
					<Skeleton className="h-4 w-full max-w-lg" />
				</div>
			))}
		</div>
	)
}

export function BillingControlsCard({
	customer,
	model,
	canEdit,
}: {
	readonly customer: BillingCustomer
	readonly model: SpendModel | null
	readonly canEdit: boolean
}) {
	const [editing, setEditing] = useState<SpendFeatureId | null>(null)
	const maximum = maximumInvoiceCents(model, customer)

	return (
		<>
			<div className="border border-border/60 bg-card/40">
				<div className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-4">
					<p className="max-w-[70ch] text-xs leading-5 text-muted-foreground">
						Each cap limits paid overage for one feature. Included usage is unaffected; Autumn
						enforces the cap while recording usage.
					</p>
					<p className="font-mono text-xs tabular-nums">
						Maximum invoice:{" "}
						{maximum === null ? "Uncapped" : formatCurrency(maximum / 100, "usd")}
					</p>
				</div>

				<div className="border-t border-border/40">
					{SPEND_FEATURES.map((featureId, index) => {
						const feature = model?.features.find((entry) => entry.featureId === featureId)
						const limit = spendLimitFor(customer, featureId)?.overageLimit
						const alert = usageAlertFor(customer, featureId)
						const stopAt =
							limit === undefined || feature?.included == null ? null : feature.included + limit

						return (
							<div
								key={featureId}
								className={`grid gap-3 px-5 py-3 sm:grid-cols-[minmax(150px,1fr)_minmax(180px,1.3fr)_minmax(160px,1fr)_auto] sm:items-center ${index > 0 ? "border-t border-border/30" : ""}`}
							>
								<div className="flex min-w-0 items-center gap-2">
									<span
										aria-hidden
										className="size-2 shrink-0 rounded-sm"
										style={{ background: FEATURE_COLORS[featureId] }}
									/>
									<span className="truncate text-[13px]">{FEATURE_LABELS[featureId]}</span>
								</div>
								<div>
									<p className="font-mono text-[13px] tabular-nums">
										{limit === undefined
											? "Paid overage uncapped"
											: `${formatUnits(featureId, limit)} paid overage`}
									</p>
									<p className="text-[11px] text-muted-foreground">
										{stopAt === null
											? "No enforced stop this cycle"
											: `Stops at ${formatUnits(featureId, stopAt)} total usage`}
									</p>
								</div>
								<p className="text-xs text-muted-foreground">
									{alert?.thresholdType === "usage_percentage"
										? `Webhook at ${alert.threshold}% of included`
										: "No usage webhook"}
								</p>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setEditing(featureId)}
									disabled={!canEdit}
								>
									Edit
								</Button>
							</div>
						)
					})}
				</div>
			</div>

			{editing !== null && (
				<BillingControlsDialog
					key={editing}
					customer={customer}
					featureId={editing}
					open
					onOpenChange={(next) => {
						if (!next) setEditing(null)
					}}
				/>
			)}
		</>
	)
}
