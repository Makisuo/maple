import { useId } from "react"

import { Label } from "@maple/ui/components/ui/label"
import { OTPField, OTPFieldInput } from "@maple/ui/components/ui/otp-field"

const SLOTS = [0, 1, 2, 3, 4, 5]

/**
 * Six-digit numeric code entry, shared by the email-verification and TOTP-enrollment dialogs.
 * Clerk's `email_code` and `totp` codes are both six digits, so one field covers both.
 *
 * Base UI deliberately ignores `aria-label` on the *first* input — that slot carries the whole
 * field's accessible name, which has to come from a real `<label>` (it logs a warning otherwise).
 * So the caption is a `Label htmlFor` pointing at slot one, and only slots two onward get
 * per-position labels.
 */
export function CodeField({
	value,
	onValueChange,
	onValueComplete,
	label,
	invalid,
	disabled,
}: {
	value: string
	onValueChange: (value: string) => void
	onValueComplete: (value: string) => void
	label: string
	invalid?: boolean
	disabled?: boolean
}) {
	const firstSlotId = useId()

	return (
		<div className="space-y-1.5">
			<Label htmlFor={firstSlotId}>{label}</Label>
			<OTPField
				length={6}
				size="lg"
				value={value}
				onValueChange={onValueChange}
				onValueComplete={onValueComplete}
				validationType="numeric"
				aria-invalid={invalid}
				disabled={disabled}
			>
				{SLOTS.map((slot) =>
					slot === 0 ? (
						<OTPFieldInput key={slot} id={firstSlotId} />
					) : (
						<OTPFieldInput key={slot} aria-label={`Digit ${slot + 1} of 6`} />
					),
				)}
			</OTPField>
		</div>
	)
}
