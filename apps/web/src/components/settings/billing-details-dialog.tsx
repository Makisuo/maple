import { useState } from "react"
import { Cause, Exit } from "effect"

import { BillingAddress, type BillingProfile, UpdateBillingProfileRequest } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@maple/ui/components/ui/combobox"
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
import { fieldOrNull } from "@/lib/billing/billing-profile"
import { countryName, sortedCountryCodes } from "@/lib/billing/countries"
import { BILLING_PROFILE_KEY, updateBillingProfileMutation } from "@/lib/services/atoms/billing-atoms"

const FIELD =
	"h-8 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-sm outline-none focus:border-ring"

const COUNTRIES = sortedCountryCodes()

/**
 * Company name + billing address, written straight to the Stripe customer.
 * Every field is optional — Stripe prints whatever is set — so an empty field
 * clears the line rather than being "invalid".
 */
export function BillingDetailsDialog({
	profile,
	open,
	onOpenChange,
}: {
	readonly profile: BillingProfile
	readonly open: boolean
	readonly onOpenChange: (open: boolean) => void
}) {
	const save = useAtomSet(updateBillingProfileMutation, { mode: "promiseExit" })
	const address = profile.address
	const [name, setName] = useState(profile.name ?? "")
	const [line1, setLine1] = useState(address?.line1 ?? "")
	const [line2, setLine2] = useState(address?.line2 ?? "")
	const [city, setCity] = useState(address?.city ?? "")
	const [state, setState] = useState(address?.state ?? "")
	const [postalCode, setPostalCode] = useState(address?.postalCode ?? "")
	const [country, setCountry] = useState<string | null>(address?.country?.toUpperCase() ?? null)
	const [saving, setSaving] = useState(false)

	async function handleSave() {
		const fields = {
			line1: fieldOrNull(line1),
			line2: fieldOrNull(line2),
			city: fieldOrNull(city),
			state: fieldOrNull(state),
			postalCode: fieldOrNull(postalCode),
			country,
		}
		const anyAddress = Object.values(fields).some((value) => value !== null)

		setSaving(true)
		const exit = await save({
			payload: new UpdateBillingProfileRequest({
				name: fieldOrNull(name),
				// All-empty clears the address outright; otherwise every line is sent
				// (null → cleared) so a removed line does not linger on the invoice.
				address: anyAddress ? new BillingAddress(fields) : null,
			}),
			reactivityKeys: [BILLING_PROFILE_KEY],
		})
		setSaving(false)

		if (Exit.isSuccess(exit)) {
			toastManager.add({ title: "Billing details saved.", type: "success" })
			onOpenChange(false)
			return
		}
		const error = Cause.squash(exit.cause)
		toastManager.add({
			title: error instanceof Error ? error.message : "Billing details could not be saved.",
			type: "error",
		})
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogPopup className="w-[480px] max-w-[calc(100vw-2rem)] gap-0 p-0">
				<DialogHeader className="px-5 pt-[18px] pb-0">
					<DialogTitle className="text-[17px] tracking-tight">Billing details</DialogTitle>
				</DialogHeader>

				<div className="space-y-4 px-5 pt-[18px]">
					<div className="space-y-1.5">
						<Label htmlFor="billing-name">Company name</Label>
						<input
							id="billing-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="Legal entity as it should appear on invoices"
							maxLength={150}
							autoComplete="organization"
							className={FIELD}
						/>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="billing-line1">Address</Label>
						<input
							id="billing-line1"
							value={line1}
							onChange={(event) => setLine1(event.target.value)}
							placeholder="Street and number"
							autoComplete="address-line1"
							className={FIELD}
						/>
						<input
							aria-label="Address line 2"
							value={line2}
							onChange={(event) => setLine2(event.target.value)}
							placeholder="Suite, floor, c/o (optional)"
							autoComplete="address-line2"
							className={FIELD}
						/>
					</div>

					<div className="grid grid-cols-[1fr_2fr] gap-2">
						<div className="space-y-1.5">
							<Label htmlFor="billing-postal">Postal code</Label>
							<input
								id="billing-postal"
								value={postalCode}
								onChange={(event) => setPostalCode(event.target.value)}
								autoComplete="postal-code"
								className={FIELD}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="billing-city">City</Label>
							<input
								id="billing-city"
								value={city}
								onChange={(event) => setCity(event.target.value)}
								autoComplete="address-level2"
								className={FIELD}
							/>
						</div>
					</div>

					<div className="grid grid-cols-2 gap-2">
						<div className="space-y-1.5">
							<Label htmlFor="billing-state">State / region</Label>
							<input
								id="billing-state"
								value={state}
								onChange={(event) => setState(event.target.value)}
								placeholder="Optional"
								autoComplete="address-level1"
								className={FIELD}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="billing-country">Country</Label>
							<Combobox<string | null>
								items={COUNTRIES}
								itemToStringLabel={(code: string | null) => (code ? countryName(code) : "")}
								value={country}
								onValueChange={(next) => setCountry(typeof next === "string" ? next : null)}
							>
								<ComboboxInput
									id="billing-country"
									placeholder="Search countries…"
									className="h-8 w-full"
								/>
								<ComboboxContent>
									<ComboboxEmpty>No country found.</ComboboxEmpty>
									<ComboboxList className="max-h-64 overflow-y-auto">
										{(code: string) => (
											<ComboboxItem key={code} value={code}>
												{countryName(code)}
											</ComboboxItem>
										)}
									</ComboboxList>
								</ComboboxContent>
							</Combobox>
						</div>
					</div>

					<p className="text-[11px] leading-4 text-muted-foreground">
						Stored on your Stripe customer and printed on every invoice from the next one on. Add
						your VAT or tax ID separately below the details.
					</p>
				</div>

				<DialogFooter className="px-5 pt-[18px] pb-5">
					<DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
					<Button size="sm" onClick={handleSave} disabled={saving}>
						{saving ? <Spinner className="size-4" /> : "Save details"}
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	)
}
