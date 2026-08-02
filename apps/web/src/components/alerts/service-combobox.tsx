import { useMemo } from "react"
import { MultiSelectCombobox } from "@maple/ui/components/multi-select-combobox"
import { ServiceDot } from "@maple/ui/components/service-dot"

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
	const items = useMemo(
		() =>
			options.map((name) => ({
				value: name,
				adornment: <ServiceDot className="size-1.5" serviceName={name} />,
			})),
		[options],
	)

	return (
		<MultiSelectCombobox
			disabled={disabled}
			emptyMessage="No services found."
			id={id}
			onChange={onChange}
			options={items}
			placeholder={placeholder ?? (serviceNames.length === 0 ? "All services" : "Add service...")}
			value={serviceNames}
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
	const items = useMemo(() => options.map((name) => ({ value: name })), [options])

	return (
		<MultiSelectCombobox
			disabled={disabled}
			emptyMessage="No environments found."
			id={id}
			onChange={onChange}
			options={items}
			placeholder={environments.length === 0 ? "All environments" : "Add environment..."}
			value={environments}
		/>
	)
}
