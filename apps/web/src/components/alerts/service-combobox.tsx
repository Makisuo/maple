import { useRef, type ReactNode } from "react"
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

interface ChipComboboxProps {
	/** Wired to the field's `<Label htmlFor>` so clicking the label focuses the input. */
	id?: string
	value: string[]
	options: string[]
	onChange: (values: string[]) => void
	disabled?: boolean
	placeholder?: string
	/** Message shown when no option matches the typed query. */
	emptyMessage: string
	/** Optional leading adornment rendered inside each chip and list item. */
	renderAdornment?: (value: string) => ReactNode
}

/**
 * Chip-based multi-select shared by the rule editor's scope fields. Keeps the
 * field mounted when `disabled` (suppressing interaction instead of unmounting)
 * so the Scope card's layout doesn't reflow as related fields toggle.
 */
function ChipCombobox({
	id,
	value,
	options,
	onChange,
	disabled,
	placeholder,
	emptyMessage,
	renderAdornment,
}: ChipComboboxProps) {
	const anchor = useRef<HTMLDivElement | null>(null)
	return (
		<Combobox
			multiple
			value={value}
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
				{value.map((item) => (
					<ComboboxChip key={item}>
						{renderAdornment?.(item)}
						{item}
					</ComboboxChip>
				))}
				<ComboboxChipsInput id={id} placeholder={placeholder} disabled={disabled} />
			</ComboboxChips>
			<ComboboxContent anchor={anchor}>
				<ComboboxEmpty>{emptyMessage}</ComboboxEmpty>
				<ComboboxList>
					{options.map((option) => (
						<ComboboxItem key={option} value={option}>
							{renderAdornment?.(option)}
							{option}
						</ComboboxItem>
					))}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	)
}

interface ServiceComboboxProps {
	id?: string
	serviceNames: string[]
	options: string[]
	onChange: (values: string[]) => void
	disabled?: boolean
	placeholder?: string
}

/**
 * Chip-based multi-select for service names, used in both `Services` and
 * `Exclude services`. Each chip carries the service's `ServiceDot` so its color
 * matches the service everywhere else in the app.
 */
export function ServiceCombobox({
	id,
	serviceNames,
	options,
	onChange,
	disabled,
	placeholder,
}: ServiceComboboxProps) {
	return (
		<ChipCombobox
			id={id}
			value={serviceNames}
			options={options}
			onChange={onChange}
			disabled={disabled}
			placeholder={placeholder ?? (serviceNames.length === 0 ? "All services" : "Add service...")}
			emptyMessage="No services found."
			renderAdornment={(name) => <ServiceDot serviceName={name} className="size-1.5" />}
		/>
	)
}

interface EnvironmentComboboxProps {
	id?: string
	environments: string[]
	options: string[]
	onChange: (values: string[]) => void
	disabled?: boolean
}

/**
 * Chip-based multi-select for deployment environments. Options come from the
 * traces `deploymentEnv` facet, which already excludes the empty-string
 * environment — so there is no synthetic "unknown" option to remap here.
 */
export function EnvironmentCombobox({
	id,
	environments,
	options,
	onChange,
	disabled,
}: EnvironmentComboboxProps) {
	return (
		<ChipCombobox
			id={id}
			value={environments}
			options={options}
			onChange={onChange}
			disabled={disabled}
			placeholder={environments.length === 0 ? "All environments" : "Add environment..."}
			emptyMessage="No environments found."
		/>
	)
}
