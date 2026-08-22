import type { BillingAddress } from "@maple/domain/http"
import { countryName } from "./countries"

/**
 * Pure helpers behind the billing-details card. The verification vocabulary
 * is Stripe's; an unknown status renders nothing rather than guessing.
 */

export type VerificationBadge = {
	readonly label: string
	readonly variant: "success" | "warning" | "secondary"
}

/** Badge copy for a Stripe tax-id verification status, or null when there is nothing worth saying. */
export const verificationBadge = (status: string | null | undefined): VerificationBadge | null => {
	switch (status) {
		case "verified":
			return { label: "Verified", variant: "success" }
		case "pending":
			return { label: "Verifying…", variant: "secondary" }
		case "unverified":
			return { label: "Not verified", variant: "warning" }
		default:
			// `unavailable` (no registry to check against) and anything Stripe adds
			// later: the id still prints on the invoice, so no badge.
			return null
	}
}

const present = (value: string | null | undefined): value is string =>
	typeof value === "string" && value.trim().length > 0

/**
 * The address as invoice lines: street lines, then "postal code city, state",
 * then the country name. Empty when nothing is set.
 */
export const formatAddressLines = (address: BillingAddress | null | undefined): ReadonlyArray<string> => {
	if (!address) return []
	const lines: string[] = []
	if (present(address.line1)) lines.push(address.line1.trim())
	if (present(address.line2)) lines.push(address.line2.trim())
	const locality = [address.postalCode, address.city]
		.filter(present)
		.map((part) => part.trim())
		.join(" ")
	const region = present(address.state) ? address.state.trim() : ""
	const localityLine = [locality, region].filter((part) => part.length > 0).join(", ")
	if (localityLine.length > 0) lines.push(localityLine)
	if (present(address.country)) lines.push(countryName(address.country.trim().toUpperCase()))
	return lines
}

/** Does the address carry anything at all? */
export const hasAddress = (address: BillingAddress | null | undefined): boolean =>
	formatAddressLines(address).length > 0

/** Trim an input field; an empty field becomes `null` so Stripe clears it. */
export const fieldOrNull = (value: string): string | null => {
	const trimmed = value.trim()
	return trimmed.length === 0 ? null : trimmed
}
