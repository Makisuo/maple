import type { IssueSeverity } from "@maple/domain/http"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"

import { SEVERITY_LABEL, SEVERITY_ORDER, SeverityDot } from "./severity-badge"

/**
 * The one control for choosing an issue severity.
 *
 * Before this there were four renderings of the same four values: a tinted-chip
 * Select on the issue rail, a plain-text dropdown in the bulk bar, a native
 * `<select>` of lowercase strings in settings, and the filter menu on the errors
 * hub. Same domain, four vocabularies — so the colour you learned in one place
 * taught you nothing about the next.
 *
 * A dot rather than the badge's tinted pill: at a Select's row height a filled
 * pill competes with the highlight state, while a dot reads at a glance and
 * lines the options up on a single left edge.
 */

/** Sentinel for "no severity". A Select's value must be a string, so `null`
 *  needs a stand-in on the wire between trigger and items. */
const NONE = "none" as const

export interface SeveritySelectProps {
	value: IssueSeverity | null
	onChange: (severity: IssueSeverity | null) => void
	disabled?: boolean
	/** Offers "Not set", and lets the caller clear a severity someone assigned. */
	includeNotSet?: boolean
	className?: string
	"aria-label"?: string
}

export function SeveritySelect({
	value,
	onChange,
	disabled,
	includeNotSet = false,
	className,
	"aria-label": ariaLabel,
}: SeveritySelectProps) {
	return (
		<Select
			value={value ?? NONE}
			disabled={disabled}
			onValueChange={(next) => onChange(next === NONE ? null : (next as IssueSeverity))}
		>
			<SelectTrigger className={className} aria-label={ariaLabel ?? "Severity"}>
				{/* Base UI prints the raw value ("critical") unless given a renderer —
				    the same trap the errors hub hit. */}
				<SelectValue placeholder="Severity">
					{(selected: string | null) => (
						<span className="flex items-center gap-2">
							<SeverityDot severity={isSeverity(selected) ? selected : null} />
							{isSeverity(selected) ? SEVERITY_LABEL[selected] : "Not set"}
						</span>
					)}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{SEVERITY_ORDER.map((severity) => (
					<SelectItem key={severity} value={severity}>
						<span className="flex items-center gap-2">
							<SeverityDot severity={severity} />
							{SEVERITY_LABEL[severity]}
						</span>
					</SelectItem>
				))}
				{includeNotSet ? (
					<SelectItem value={NONE}>
						<span className="flex items-center gap-2">
							<SeverityDot severity={null} />
							Not set
						</span>
					</SelectItem>
				) : null}
			</SelectContent>
		</Select>
	)
}

function isSeverity(value: string | null): value is IssueSeverity {
	return value !== null && (SEVERITY_ORDER as ReadonlyArray<string>).includes(value)
}
