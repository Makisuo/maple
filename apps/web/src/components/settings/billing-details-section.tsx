import { useState } from "react"
import { Cause, Exit, Schema } from "effect"

import {
	AddBillingTaxIdRequest,
	BillingNotConfiguredError,
	type BillingProfile,
	type BillingTaxId,
} from "@maple/domain/http"
import {
	TAX_ID_TYPES,
	defaultTaxIdTypeFor,
	isTaxIdType,
	taxIdExampleFor,
	taxIdLabel,
} from "@maple/domain/billing-tax-ids"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { toastManager } from "@maple/ui/components/ui/toast"
import { cn } from "@maple/ui/lib/utils"

import { XmarkIcon } from "@/components/icons"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { formatAddressLines, verificationBadge } from "@/lib/billing/billing-profile"
import {
	BILLING_PROFILE_KEY,
	addBillingTaxIdMutation,
	billingProfileAtom,
	removeBillingTaxIdMutation,
} from "@/lib/services/atoms/billing-atoms"
import { BillingDetailsDialog } from "./billing-details-dialog"

// A self-hosted API with no STRIPE_SECRET_KEY answers every profile read with
// this; that is a deployment choice, not an outage, and reads differently.
const isNotConfigured = Schema.is(BillingNotConfiguredError)

const LABEL = "text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/60"
const FIELD =
	"h-8 min-w-0 rounded-md border border-input bg-background px-2.5 font-mono text-sm outline-none focus:border-ring"

// Type picker order: the handful most customers want, then everything else
// alphabetically by label. One flat list — a grouped 100-entry select reads
// worse than a short head + long tail.
const FEATURED_TYPES: ReadonlyArray<string> = [
	"eu_vat",
	"gb_vat",
	"ch_vat",
	"us_ein",
	"ca_gst_hst",
	"au_abn",
	"in_gst",
]
const TYPE_OPTIONS = [
	...FEATURED_TYPES.flatMap((type) => TAX_ID_TYPES.filter((info) => info.type === type)),
	...TAX_ID_TYPES.filter((info) => !FEATURED_TYPES.includes(info.type)).sort((a, b) =>
		a.label.localeCompare(b.label),
	),
].map((info) => ({ value: info.type, label: info.label }))

export function BillingDetailsSkeleton() {
	return (
		<div className="border border-border/60 bg-card/40">
			<div className="grid grid-cols-1 gap-6 px-5 py-4 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Skeleton className="h-2.5 w-16" />
					<Skeleton className="h-4 w-40" />
					<Skeleton className="h-4 w-32" />
				</div>
				<div className="flex flex-col gap-1.5">
					<Skeleton className="h-2.5 w-12" />
					<Skeleton className="h-4 w-48" />
				</div>
			</div>
		</div>
	)
}

function TaxIdRow({
	taxId,
	canEdit,
	onRemove,
	removing,
}: {
	readonly taxId: BillingTaxId
	readonly canEdit: boolean
	readonly onRemove: () => void
	readonly removing: boolean
}) {
	const badge = verificationBadge(taxId.verificationStatus)
	return (
		<li className="flex items-center gap-3 py-1.5">
			<span className="font-mono text-sm tabular-nums">{taxId.value}</span>
			<span className="truncate text-xs text-muted-foreground">{taxIdLabel(taxId.type)}</span>
			{badge && (
				<Badge size="sm" variant={badge.variant}>
					{badge.label}
				</Badge>
			)}
			{canEdit && (
				<button
					type="button"
					onClick={onRemove}
					disabled={removing}
					aria-label={`Remove ${taxIdLabel(taxId.type)} ${taxId.value}`}
					className="ml-auto text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
				>
					{removing ? <Spinner className="size-3.5" /> : <XmarkIcon size={14} />}
				</button>
			)}
		</li>
	)
}

function AddTaxIdRow({ profile }: { readonly profile: BillingProfile }) {
	const add = useAtomSet(addBillingTaxIdMutation, { mode: "promiseExit" })
	const [type, setType] = useState<string>(defaultTaxIdTypeFor(profile.address?.country) ?? "eu_vat")
	const [value, setValue] = useState("")
	const [adding, setAdding] = useState(false)

	async function handleAdd() {
		const trimmed = value.trim()
		if (!isTaxIdType(type)) return
		if (trimmed.length === 0) {
			toastManager.add({ title: "Enter the tax ID first.", type: "error" })
			return
		}
		setAdding(true)
		const exit = await add({
			payload: new AddBillingTaxIdRequest({ type, value: trimmed }),
			reactivityKeys: [BILLING_PROFILE_KEY],
		})
		setAdding(false)
		if (Exit.isSuccess(exit)) {
			setValue("")
			toastManager.add({ title: "Tax ID added. Stripe is verifying it.", type: "success" })
			return
		}
		const error = Cause.squash(exit.cause)
		toastManager.add({
			title: error instanceof Error ? error.message : "The tax ID could not be added.",
			type: "error",
		})
	}

	return (
		<div className="flex flex-wrap items-center gap-2">
			<Select items={TYPE_OPTIONS} value={type} onValueChange={(next) => next && setType(next)}>
				<SelectTrigger aria-label="Tax ID type" className="h-8 w-56 text-xs">
					<SelectValue />
				</SelectTrigger>
				<SelectContent className="max-h-72">
					{TYPE_OPTIONS.map((option) => (
						<SelectItem key={option.value} value={option.value} className="text-xs">
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<input
				aria-label="Tax ID"
				value={value}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") void handleAdd()
				}}
				placeholder={taxIdExampleFor(type, profile.address?.country)}
				className={cn(FIELD, "w-56")}
			/>
			<Button size="sm" variant="outline" onClick={handleAdd} disabled={adding}>
				{adding ? <Spinner className="size-4" /> : "Add tax ID"}
			</Button>
		</div>
	)
}

/**
 * Company name, address and tax IDs as they will print on the invoice. Read
 * from (and written to) the Stripe customer behind the Autumn subscription.
 */
export function BillingDetailsSection({ canEdit }: { readonly canEdit: boolean }) {
	const profileResult = useAtomValue(billingProfileAtom)
	const remove = useAtomSet(removeBillingTaxIdMutation, { mode: "promiseExit" })
	const [editing, setEditing] = useState(false)
	const [removingId, setRemovingId] = useState<string | null>(null)

	if (Result.isInitial(profileResult)) return <BillingDetailsSkeleton />

	if (!Result.isSuccess(profileResult)) {
		const notConfigured =
			Result.isFailure(profileResult) && isNotConfigured(Cause.squash(profileResult.cause))
		return (
			<div className="border border-border/60 bg-card/40 px-5 py-4">
				<p className="text-sm text-muted-foreground">
					{notConfigured
						? "Billing details aren't set up for this deployment. Company name, address and tax IDs are managed in the billing portal instead."
						: "Billing details aren't available right now. Try again in a moment — your invoices still carry the details already on file."}
				</p>
			</div>
		)
	}

	const profile = profileResult.value
	const addressLines = formatAddressLines(profile.address)

	async function handleRemove(taxId: BillingTaxId) {
		setRemovingId(taxId.id)
		const exit = await remove({
			params: { taxIdId: taxId.id },
			reactivityKeys: [BILLING_PROFILE_KEY],
		})
		setRemovingId(null)
		if (Exit.isSuccess(exit)) {
			toastManager.add({ title: `Removed ${taxIdLabel(taxId.type)} ${taxId.value}.`, type: "success" })
			return
		}
		const error = Cause.squash(exit.cause)
		toastManager.add({
			title: error instanceof Error ? error.message : "The tax ID could not be removed.",
			type: "error",
		})
	}

	return (
		<>
			<div className="border border-border/60 bg-card/40">
				<div className="grid grid-cols-1 gap-x-8 gap-y-5 px-5 py-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto]">
					<div className="flex flex-col gap-1">
						<span className={LABEL}>Bill to</span>
						{profile.name ? (
							<span className="text-sm">{profile.name}</span>
						) : (
							<span className="text-sm text-muted-foreground/70">No company name</span>
						)}
						{addressLines.length > 0 ? (
							<span className="text-sm leading-5 text-muted-foreground">
								{addressLines.map((line) => (
									<span key={line} className="block">
										{line}
									</span>
								))}
							</span>
						) : (
							<span className="text-sm text-muted-foreground/70">No billing address</span>
						)}
					</div>

					<div className="flex flex-col gap-1">
						<span className={LABEL}>Tax IDs</span>
						{profile.taxIds.length === 0 ? (
							<span className="text-sm text-muted-foreground/70">
								{profile.linked
									? "None on file"
									: "Available once your organization has a plan"}
							</span>
						) : (
							<ul className="-my-1.5 divide-y divide-border/40">
								{profile.taxIds.map((taxId) => (
									<TaxIdRow
										key={taxId.id}
										taxId={taxId}
										canEdit={canEdit}
										removing={removingId === taxId.id}
										onRemove={() => void handleRemove(taxId)}
									/>
								))}
							</ul>
						)}
					</div>

					{canEdit && (
						<div className="flex items-start sm:justify-end">
							<Button variant="outline" size="sm" onClick={() => setEditing(true)}>
								Edit details
							</Button>
						</div>
					)}
				</div>

				{canEdit && (
					<div className="border-t border-border/40 px-5 py-3">
						<AddTaxIdRow key={profile.address?.country ?? "none"} profile={profile} />
						<p className="mt-2 text-[11px] leading-4 text-muted-foreground">
							EU, UK and Australian numbers are checked against the official registry; the ID is
							printed on invoices either way.
						</p>
					</div>
				)}
			</div>

			{editing && <BillingDetailsDialog profile={profile} open={editing} onOpenChange={setEditing} />}
		</>
	)
}
