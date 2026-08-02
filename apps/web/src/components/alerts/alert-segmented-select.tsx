import type { ReactNode } from "react"
import { useId } from "react"
import { motion } from "motion/react"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import { cn } from "@maple/ui/utils"
import { CheckIcon } from "@/components/icons"

export type AlertSegmentedOption<T extends string> = {
	value: T
	label: ReactNode
	icon?: ReactNode
	disabled?: boolean
}

type Size = "sm" | "default"

/* The shared segmented control (a recessed track with one raised pill — see
   packages/ui toggle-group.tsx) plus a *sliding* pill: the indicator is a Motion
   shared-layout element (`layoutId`), so changing the selection animates it
   gliding to its new slot instead of snapping a background on and off. The track
   and pill styling come from the shared component; this only swaps the static
   pill for the animated one. */
export function AlertSegmentedSelect<T extends string>({
	options,
	value,
	onChange,
	size = "default",
	className,
	"aria-label": ariaLabel,
}: {
	options: ReadonlyArray<AlertSegmentedOption<T>>
	value: T
	onChange: (value: T) => void
	size?: Size
	className?: string
	"aria-label"?: string
}) {
	const pillId = useId()
	return (
		<ToggleGroup
			value={[value]}
			onValueChange={(values) => {
				const next = values[0] as T | undefined
				if (next && next !== value) onChange(next)
			}}
			variant="outline"
			size={size}
			aria-label={ariaLabel}
			className={className}
		>
			{options.map((option) => {
				const selected = option.value === value
				return (
					<ToggleGroupItem
						key={option.value}
						value={option.value}
						disabled={option.disabled}
						aria-label={typeof option.label === "string" ? option.label : option.value}
						// The shared segment already paints a static pill on the
						// pressed item; suppress it so the sliding one below is the
						// only selection indicator.
						className={cn(
							"relative",
							"data-pressed:border-transparent data-pressed:bg-transparent data-pressed:shadow-none dark:data-pressed:bg-transparent",
						)}
					>
						{selected && (
							<motion.span
								aria-hidden
								layoutId={`alert-seg-pill-${pillId}`}
								className="-z-10 absolute inset-0 rounded-md bg-background shadow-sm ring-1 ring-border/70 dark:bg-input dark:ring-white/10"
								transition={{ type: "spring", stiffness: 380, damping: 32 }}
							/>
						)}
						{option.icon}
						{option.label}
					</ToggleGroupItem>
				)
			})}
		</ToggleGroup>
	)
}

export function AlertMultiSegmentedSelect<T extends string>({
	options,
	value,
	onChange,
	size = "default",
	className,
	"aria-label": ariaLabel,
}: {
	options: ReadonlyArray<AlertSegmentedOption<T>>
	value: readonly T[]
	onChange: (value: T[]) => void
	size?: Size
	className?: string
	"aria-label"?: string
}) {
	return (
		<ToggleGroup
			multiple
			connected={false}
			value={value}
			onValueChange={(next) => onChange(next as T[])}
			variant="outline"
			size={size}
			aria-label={ariaLabel}
			className={className}
		>
			{options.map((option) => {
				const selected = value.includes(option.value)
				return (
					<ToggleGroupItem
						key={option.value}
						value={option.value}
						disabled={option.disabled}
						aria-label={typeof option.label === "string" ? option.label : option.value}
						className={cn(
							"transition-colors",
							selected &&
								"border-primary/70 data-pressed:border-primary/70 data-pressed:bg-primary/10 data-pressed:text-foreground hover:bg-primary/15 dark:hover:bg-primary/15",
						)}
					>
						{(option.icon || selected) && (
							<span className="flex size-3.5 shrink-0 items-center justify-center">
								{selected ? (
									<CheckIcon className="size-3.5 text-primary opacity-100" />
								) : (
									option.icon
								)}
							</span>
						)}
						{option.label}
					</ToggleGroupItem>
				)
			})}
		</ToggleGroup>
	)
}
