import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"

/**
 * A single-select segmented control over a small closed set: which metric a
 * chart shows, which workload kind a list is about.
 *
 * Built on the shared `ToggleGroup` track rather than the hand-rolled
 * `bg-foreground` pill that five infra pages had each copied — the track is the
 * design system's segmented control, and the copies had drifted on radius,
 * padding and label size.
 */
export function SegmentPivot<V extends string>({
	options,
	value,
	onChange,
	ariaLabel,
	className,
}: {
	options: ReadonlyArray<{ value: V; label: string }>
	value: V
	onChange: (value: V) => void
	ariaLabel: string
	className?: string
}) {
	return (
		<ToggleGroup
			variant="outline"
			size="sm"
			aria-label={ariaLabel}
			value={[value]}
			// Base UI reports a deselect as an empty array; a pivot always has a
			// value, so a click on the active segment is a no-op rather than a hole.
			onValueChange={(next: ReadonlyArray<unknown>) => {
				const picked = options.find((option) => option.value === next[0])
				if (picked) onChange(picked.value)
			}}
			className={className}
		>
			{options.map((option) => (
				<ToggleGroupItem
					key={option.value}
					value={option.value}
					className="h-6 text-[11px] sm:h-6 sm:text-[11px]"
				>
					{option.label}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	)
}
