import { useMemo } from "react"
import { format } from "date-fns"
import type { BillingInvoice } from "@maple/domain/http"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { billingInvoicesAtom } from "@/lib/services/atoms/billing-atoms"
import { formatCurrency } from "@/lib/billing/currency"

// Stripe invoice statuses → badge treatment. Unknown statuses fall through to a
// plain secondary badge with the raw status text, never a crash.
function statusBadge(status: string) {
	switch (status.toLowerCase()) {
		case "paid":
			return { label: "Paid", variant: "success" as const }
		case "open":
			return { label: "Due", variant: "warning" as const }
		case "uncollectible":
		case "past_due":
			return { label: "Past due", variant: "error" as const }
		case "draft":
			return { label: "Draft", variant: "secondary" as const }
		case "void":
			return { label: "Void", variant: "secondary" as const }
		default:
			return { label: status, variant: "secondary" as const }
	}
}

function planLabel(invoice: BillingInvoice): string {
	const ids = invoice.planIds ?? []
	if (ids.length === 0) return "—"
	// planIds are catalog slugs ("startup"); capitalize for display.
	return ids.map((id) => id.charAt(0).toUpperCase() + id.slice(1)).join(" + ")
}

function InvoiceRow({ invoice }: { invoice: BillingInvoice }) {
	const badge = statusBadge(invoice.status)
	return (
		<div className="flex items-center gap-4 py-2.5">
			<span className="w-28 shrink-0 whitespace-nowrap text-sm tabular-nums">
				{format(new Date(invoice.createdAt), "MMM d, yyyy")}
			</span>
			<span className="text-muted-foreground min-w-0 flex-1 truncate text-sm">
				{planLabel(invoice)}
			</span>
			<Badge size="sm" variant={badge.variant}>
				{badge.label}
			</Badge>
			<span className="w-20 shrink-0 text-right text-sm tabular-nums">
				{formatCurrency(invoice.total, invoice.currency)}
			</span>
			<span className="w-12 shrink-0 text-right">
				{invoice.hostedInvoiceUrl ? (
					<a
						href={invoice.hostedInvoiceUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="text-primary text-xs font-medium hover:underline"
					>
						View
					</a>
				) : null}
			</span>
		</div>
	)
}

function InvoicesSkeleton() {
	return (
		<div className="divide-y divide-border/60">
			{Array.from({ length: 3 }).map((_, i) => (
				<div key={i} className="flex items-center gap-4 py-2.5">
					<Skeleton className="h-3.5 w-24" />
					<Skeleton className="h-3.5 w-20 flex-1" />
					<Skeleton className="h-4 w-10" />
					<Skeleton className="h-3.5 w-14" />
				</div>
			))}
		</div>
	)
}

/**
 * Invoice history from Autumn/Stripe: date, plan, status, amount, and a link to
 * the Stripe-hosted invoice (view/PDF). Newest first. On upstream failure the
 * Stripe billing portal (via the provided handler) remains the escape hatch.
 */
export function InvoicesSection({ onManageBilling }: { onManageBilling: () => void }) {
	const invoicesResult = useAtomValue(billingInvoicesAtom)

	const invoices = useMemo(() => {
		if (!Result.isSuccess(invoicesResult)) return []
		return [...invoicesResult.value.invoices].sort((a, b) => b.createdAt - a.createdAt)
	}, [invoicesResult])

	if (Result.isInitial(invoicesResult)) return <InvoicesSkeleton />

	if (!Result.isSuccess(invoicesResult)) {
		return (
			<div className="flex items-center justify-between gap-4">
				<p className="text-muted-foreground text-sm">
					Couldn't load invoices. You can still view them in the billing portal.
				</p>
				<Button variant="outline" size="sm" onClick={onManageBilling}>
					Open billing portal
				</Button>
			</div>
		)
	}

	if (invoices.length === 0) {
		return <p className="text-muted-foreground text-sm">No invoices yet.</p>
	}

	return (
		<div className="divide-y divide-border/60">
			{invoices.map((invoice, index) => (
				<InvoiceRow key={invoice.stripeId ?? `${invoice.createdAt}:${index}`} invoice={invoice} />
			))}
		</div>
	)
}
