import type { ReactNode } from "react"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import { cn } from "@maple/ui/utils"

export type AlertSegmentedOption<T extends string> = {
	value: T
	label: ReactNode
	icon?: ReactNode
	disabled?: boolean
}

type Size = "sm" | "default"

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
			className={cn("w-fit", className)}
		>
			{options.map((option) => (
				<ToggleGroupItem
					key={option.value}
					value={option.value}
					disabled={option.disabled}
					aria-label={typeof option.label === "string" ? option.label : option.value}
				>
					{option.icon}
					{option.label}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	)
}

export function AlertMultiSegmentedSelect<T extends string>({
	options,
	value,
	onChange,
	size = "default",
	className,
	spacing = 6,
	"aria-label": ariaLabel,
}: {
	options: ReadonlyArray<AlertSegmentedOption<T>>
	value: readonly T[]
	onChange: (value: T[]) => void
	size?: Size
	className?: string
	spacing?: number
	"aria-label"?: string
}) {
	return (
		<ToggleGroup
			multiple
			value={value}
			onValueChange={(next) => onChange(next as T[])}
			variant="outline"
			size={size}
			spacing={spacing}
			aria-label={ariaLabel}
			className={cn("flex-wrap", className)}
		>
			{options.map((option) => (
				<ToggleGroupItem
					key={option.value}
					value={option.value}
					disabled={option.disabled}
					aria-label={typeof option.label === "string" ? option.label : option.value}
				>
					{option.icon}
					{option.label}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	)
}
