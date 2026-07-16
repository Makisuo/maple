import { useRef } from "react"
import { cn } from "@maple/ui/utils"
import {
	Combobox,
	ComboboxChips,
	ComboboxChip,
	ComboboxChipsInput,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxItem,
	ComboboxList,
} from "@maple/ui/components/ui/combobox"
import { ServiceDot } from "@maple/ui/components/service-dot"

interface ServiceComboboxProps {
	serviceNames: string[]
	options: string[]
	onChange: (values: string[]) => void
	disabled?: boolean
	placeholder?: string
}

/**
 * Chip-based multi-select for service names used in both `Services` and
 * `Exclude services`. When `disabled`, suppresses interaction but keeps the
 * field mounted so the layout doesn't reflow as related fields toggle.
 */
export function ServiceCombobox({
	serviceNames,
	options,
	onChange,
	disabled,
	placeholder,
}: ServiceComboboxProps) {
	const anchor = useRef<HTMLDivElement | null>(null)
	return (
		<Combobox
			multiple
			value={serviceNames}
			onValueChange={(values) => {
				if (disabled) return
				onChange(values as string[])
			}}
		>
			<ComboboxChips
				ref={anchor}
				aria-disabled={disabled || undefined}
				className={cn(disabled && "pointer-events-none opacity-60")}
			>
				{serviceNames.map((name) => (
					<ComboboxChip key={name}>
						<ServiceDot serviceName={name} className="size-1.5" />
						{name}
					</ComboboxChip>
				))}
				<ComboboxChipsInput
					placeholder={
						placeholder ?? (serviceNames.length === 0 ? "All services" : "Add service...")
					}
					disabled={disabled}
				/>
			</ComboboxChips>
			<ComboboxContent anchor={anchor}>
				<ComboboxEmpty>No services found.</ComboboxEmpty>
				<ComboboxList>
					{options.map((svc) => (
						<ComboboxItem key={svc} value={svc}>
							<ServiceDot serviceName={svc} className="size-1.5" />
							{svc}
						</ComboboxItem>
					))}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	)
}
