import { useRef } from "react"
import { Button } from "@maple/ui/components/ui/button"
import {
	Combobox,
	ComboboxChipsInput,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxItem,
	ComboboxList,
	ComboboxTrigger,
} from "@maple/ui/components/ui/combobox"
import { cn } from "@maple/ui/utils"
import { ChevronDownIcon, PlusIcon } from "@/components/icons"
import {
	useDashboardVariables,
	type VariableOptionsState,
} from "@/components/dashboard-builder/dashboard-variables-context"
import { ALL_VALUE, type ResolvedVariable } from "@/lib/dashboard-variables/interpolate"
import type { DashboardVariable } from "@/components/dashboard-builder/types"

/**
 * One selector per dashboard variable, rendered in the toolbar next to the
 * time range picker. Each renders as a compact filter chip
 * (`label value ⌄`) that opens a searchable list — option lists come from
 * live telemetry and can run into the hundreds.
 *
 * In edit mode an extra `+ Variable` chip opens the manager, so the feature
 * is discoverable without digging through the overflow menu.
 */
export function VariableSelects({ onManage }: { onManage?: () => void }) {
	const { variables, values, optionsByName, setValue } = useDashboardVariables()

	if (variables.length === 0 && !onManage) return null

	return (
		<div className="flex items-center gap-1.5">
			{variables.map((variable) => (
				<VariableControl
					key={variable.name}
					variable={variable}
					resolved={values[variable.name]}
					options={optionsByName[variable.name] ?? { options: [], loading: false }}
					onChange={(value) => setValue(variable.name, value)}
				/>
			))}
			{onManage && (
				<Button
					variant="ghost"
					size="sm"
					className="text-muted-foreground"
					onClick={onManage}
					aria-label={
						variables.length === 0 ? "Add dashboard variable" : "Manage dashboard variables"
					}
				>
					<PlusIcon size={13} data-icon="inline-start" />
					{variables.length === 0 ? "Variable" : null}
				</Button>
			)}
		</div>
	)
}

function chipLabel(variable: DashboardVariable): string {
	return variable.label ?? variable.name
}

function displayValue(resolved: ResolvedVariable | undefined, options: VariableOptionsState): string {
	if (resolved === undefined) return options.loading ? "…" : "—"
	if (resolved.isAll) return "All"
	return resolved.value === "" ? "—" : resolved.value
}

function VariableControl({
	variable,
	resolved,
	options,
	onChange,
}: {
	variable: DashboardVariable
	resolved: ResolvedVariable | undefined
	options: VariableOptionsState
	onChange: (value: string) => void
}) {
	const anchor = useRef<HTMLSpanElement | null>(null)

	if (variable.type === "textbox") {
		return <TextboxControl variable={variable} resolved={resolved} onChange={onChange} />
	}

	const value = resolved?.isAll ? ALL_VALUE : (resolved?.value ?? "")
	const items = [...options.options]
	if (variable.includeAll === true) items.unshift(ALL_VALUE)
	// Keep a URL/default-pinned value selectable even when it isn't (yet) in
	// the loaded option list, so the current selection is always visible.
	if (value !== "" && value !== ALL_VALUE && !items.includes(value)) {
		items.splice(variable.includeAll === true ? 1 : 0, 0, value)
	}

	return (
		<Combobox
			items={items}
			itemToStringLabel={(item: string) => (item === ALL_VALUE ? "All" : item)}
			value={value}
			onValueChange={(next) => {
				if (typeof next === "string" && next.length > 0) onChange(next)
			}}
		>
			<span ref={anchor} className="inline-flex">
				<ComboboxTrigger
					render={
						<Button
							variant="outline"
							size="sm"
							className="max-w-64 gap-1.5 font-mono"
							aria-label={`${chipLabel(variable)} variable`}
							disabled={resolved === undefined && options.loading}
						/>
					}
				>
					<span className="text-muted-foreground">{chipLabel(variable)}</span>
					<span className={cn("truncate", resolved === undefined && "text-muted-foreground")}>
						{displayValue(resolved, options)}
					</span>
					<ChevronDownIcon size={12} className="shrink-0 text-muted-foreground" />
				</ComboboxTrigger>
			</span>
			<ComboboxContent anchor={anchor} className="min-w-52" sideOffset={6}>
				<div className="border-b border-border px-1.5 py-1.5">
					<ComboboxChipsInput
						size="sm"
						placeholder={`Search ${chipLabel(variable)}…`}
						className="w-full font-mono"
					/>
				</div>
				<ComboboxEmpty>{options.loading ? "Loading values…" : "No matching values."}</ComboboxEmpty>
				<ComboboxList className="max-h-72 overflow-y-auto p-1">
					{(item: string) =>
						item === ALL_VALUE ? (
							<ComboboxItem key={item} value={item} className="text-xs">
								All
								<span className="ml-auto pl-4 text-[10px] text-muted-foreground">
									no filter
								</span>
							</ComboboxItem>
						) : (
							<ComboboxItem key={item} value={item} className="font-mono text-xs">
								{item}
							</ComboboxItem>
						)
					}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	)
}

function TextboxControl({
	variable,
	resolved,
	onChange,
}: {
	variable: DashboardVariable
	resolved: ResolvedVariable | undefined
	onChange: (value: string) => void
}) {
	const current = resolved?.value ?? ""
	return (
		<div className="flex h-8 items-center overflow-hidden rounded-lg border border-input bg-transparent text-xs shadow-xs focus-within:ring-2 focus-within:ring-ring">
			<span className="border-r border-input px-2 font-mono text-muted-foreground">
				{chipLabel(variable)}
			</span>
			{/* Uncontrolled + keyed so external value changes (URL nav) reset the
			    field while typing stays local until commit (blur / Enter). */}
			<input
				key={current}
				defaultValue={current}
				placeholder="any"
				aria-label={`${chipLabel(variable)} variable`}
				className="h-full w-28 bg-transparent px-2 font-mono outline-none placeholder:text-muted-foreground"
				onBlur={(event) => {
					if (event.target.value !== current) onChange(event.target.value)
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") event.currentTarget.blur()
				}}
			/>
		</div>
	)
}
