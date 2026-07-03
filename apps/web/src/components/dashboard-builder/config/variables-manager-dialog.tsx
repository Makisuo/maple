import { useState } from "react"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Switch } from "@maple/ui/components/ui/switch"
import { Textarea } from "@maple/ui/components/ui/textarea"
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@maple/ui/components/ui/select"
import { Schema } from "effect"
import { DashboardVariableName } from "@maple/domain/http"
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, PlusIcon, TrashIcon } from "@/components/icons"
import type { DashboardVariable } from "@/components/dashboard-builder/types"

const isValidVariableName = Schema.is(DashboardVariableName)

type QueryVariable = Extract<DashboardVariable, { type: "query" }>
type QueryFacet = Extract<QueryVariable["source"], { kind: "facet" }>["facet"]

const FACET_LABELS: Record<QueryFacet, string> = {
	service: "Service",
	environment: "Environment",
	span_name: "Span name",
	http_method: "HTTP method",
	http_status_code: "HTTP status code",
	log_severity: "Log severity",
}

const TYPE_LABELS: Record<DashboardVariable["type"], string> = {
	query: "Query",
	custom: "Custom",
	textbox: "Textbox",
}

const TYPE_OPTIONS: Record<DashboardVariable["type"], string> = {
	query: "Query (from telemetry)",
	custom: "Custom (static list)",
	textbox: "Textbox (free text)",
}

function sourceSummary(variable: DashboardVariable): string {
	if (variable.type === "custom") {
		return variable.options.map((option) => option.value).join(", ") || "No options"
	}
	if (variable.type === "textbox") {
		return "Free text"
	}
	return variable.source.kind === "facet"
		? FACET_LABELS[variable.source.facet]
		: `${variable.source.scope} attribute: ${variable.source.attributeKey || "…"}`
}

function newVariable(): DashboardVariable {
	return { name: "", type: "query", source: { kind: "facet", facet: "service" } }
}

// Retype a variable, keeping the shared base fields.
function withType(variable: DashboardVariable, type: DashboardVariable["type"]): DashboardVariable {
	const base = {
		name: variable.name,
		...(variable.label !== undefined && { label: variable.label }),
		...(variable.includeAll !== undefined && { includeAll: variable.includeAll }),
		...(variable.defaultValue !== undefined && { defaultValue: variable.defaultValue }),
	}
	switch (type) {
		case "query":
			return { ...base, type, source: { kind: "facet", facet: "service" } }
		case "custom":
			return { ...base, type, options: [] }
		case "textbox":
			return { ...base, type }
	}
}

// Per-draft validation, computed live so problems surface inline on the row
// being edited instead of only when Save is pressed.
function draftError(
	draft: DashboardVariable,
	index: number,
	drafts: DashboardVariable[],
): string | null {
	if (draft.name === "") {
		return "Name is required."
	}
	if (!isValidVariableName(draft.name)) {
		return "Names start with a letter, then letters, digits, or underscores."
	}
	if (drafts.some((other, i) => i !== index && other.name === draft.name)) {
		return `Another variable is already named "${draft.name}".`
	}
	if (draft.type === "query" && draft.source.kind === "attribute" && !draft.source.attributeKey.trim()) {
		return "Pick the attribute key to list values for."
	}
	return null
}

export function VariablesManagerDialog({
	open,
	onOpenChange,
	variables,
	onSave,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	variables: DashboardVariable[]
	onSave: (variables: DashboardVariable[]) => void
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-xl">
				{/* Mounted only while open so each session starts from the saved state. */}
				{open && (
					<VariablesEditor
						initial={variables}
						onCancel={() => onOpenChange(false)}
						onSave={(next) => {
							onSave(next)
							onOpenChange(false)
						}}
					/>
				)}
			</DialogContent>
		</Dialog>
	)
}

function VariablesEditor({
	initial,
	onCancel,
	onSave,
}: {
	initial: DashboardVariable[]
	onCancel: () => void
	onSave: (variables: DashboardVariable[]) => void
}) {
	// With no variables yet, land the user directly in "create" — one blank
	// draft with its form expanded — instead of an empty list behind an Add button.
	const startedEmpty = initial.length === 0
	const [drafts, setDrafts] = useState<DashboardVariable[]>(() =>
		startedEmpty ? [newVariable()] : structuredClone(initial),
	)
	const [editingIndex, setEditingIndex] = useState<number | null>(startedEmpty ? 0 : null)

	const errors = drafts.map((draft, index) => draftError(draft, index, drafts))
	const hasErrors = errors.some((error) => error !== null)

	const updateDraft = (index: number, next: DashboardVariable) => {
		setDrafts((prev) => prev.map((draft, i) => (i === index ? next : draft)))
	}

	const move = (index: number, delta: -1 | 1) => {
		setDrafts((prev) => {
			const target = index + delta
			if (target < 0 || target >= prev.length) return prev
			const next = [...prev]
			const [item] = next.splice(index, 1)
			next.splice(target, 0, item!)
			return next
		})
		setEditingIndex((current) =>
			current === index ? index + delta : current === index + delta ? index : current,
		)
	}

	const remove = (index: number) => {
		setDrafts((prev) => prev.filter((_, i) => i !== index))
		setEditingIndex((current) =>
			current === null ? null : current === index ? null : current > index ? current - 1 : current,
		)
	}

	const add = () => {
		setDrafts((prev) => [...prev, newVariable()])
		setEditingIndex(drafts.length)
	}

	const handleSave = () => {
		if (hasErrors) return
		onSave(drafts)
	}

	return (
		<>
			<DialogHeader>
				<DialogTitle>Dashboard variables</DialogTitle>
				<DialogDescription>
					Reference variables as <code className="text-[11px]">$name</code> in widget filters and raw
					SQL. Selectors appear in the dashboard toolbar.
				</DialogDescription>
			</DialogHeader>
			<DialogPanel className="flex flex-col gap-3">
				{startedEmpty && (
					<div className="rounded-md border border-dashed border-border px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">
						<p>
							A variable adds a selector to the toolbar; widgets that reference it re-query
							when the selection changes.
						</p>
						<ul className="mt-1.5 flex flex-col gap-0.5">
							<li>
								<span className="text-foreground">Query</span> — values from your telemetry
								(services, environments, attribute values).
							</li>
							<li>
								<span className="text-foreground">Custom</span> — a fixed list you define.
							</li>
							<li>
								<span className="text-foreground">Textbox</span> — free text, e.g. a search
								needle.
							</li>
						</ul>
					</div>
				)}
				{drafts.map((draft, index) => (
					<div key={index} className="rounded-md border border-border">
						<div className="flex items-center gap-2 px-3 py-2">
							<div className="flex min-w-0 flex-1 flex-col">
								<span className="truncate font-mono text-xs font-medium text-foreground">
									${draft.name || "…"}
									<span className="ml-2 font-sans font-normal text-muted-foreground">
										{TYPE_LABELS[draft.type]}
									</span>
								</span>
								<span className="truncate text-[11px] text-muted-foreground">
									{errors[index] !== null && editingIndex !== index ? (
										<span className="text-destructive">{errors[index]}</span>
									) : (
										sourceSummary(draft)
									)}
								</span>
							</div>
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label="Move up"
								disabled={index === 0}
								onClick={() => move(index, -1)}
							>
								<ArrowUpIcon size={13} />
							</Button>
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label="Move down"
								disabled={index === drafts.length - 1}
								onClick={() => move(index, 1)}
							>
								<ArrowDownIcon size={13} />
							</Button>
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label="Edit variable"
								onClick={() => setEditingIndex(editingIndex === index ? null : index)}
							>
								<PencilIcon size={13} />
							</Button>
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label="Delete variable"
								onClick={() => remove(index)}
							>
								<TrashIcon size={13} />
							</Button>
						</div>
						{editingIndex === index && (
							<div className="border-t border-border px-3 py-3">
								<VariableForm
									variable={draft}
									error={errors[index] ?? null}
									onChange={(next) => updateDraft(index, next)}
								/>
							</div>
						)}
					</div>
				))}
				<Button variant="outline" size="sm" className="self-start" onClick={add}>
					<PlusIcon size={14} data-icon="inline-start" />
					Add variable
				</Button>
			</DialogPanel>
			<DialogFooter>
				<Button type="button" variant="outline" size="sm" onClick={onCancel}>
					Cancel
				</Button>
				<Button type="button" size="sm" onClick={handleSave} disabled={hasErrors}>
					Save variables
				</Button>
			</DialogFooter>
		</>
	)
}

function VariableForm({
	variable,
	error,
	onChange,
}: {
	variable: DashboardVariable
	error: string | null
	onChange: (variable: DashboardVariable) => void
}) {
	return (
		<div className="flex flex-col gap-3">
			<div className="grid grid-cols-2 gap-3">
				<div className="flex flex-col gap-1.5">
					<Label className="text-xs">Name</Label>
					<Input
						size="sm"
						autoFocus={variable.name === ""}
						value={variable.name}
						placeholder="service"
						aria-invalid={error !== null || undefined}
						onChange={(event) => onChange({ ...variable, name: event.target.value })}
					/>
					{error !== null ? (
						<span className="text-[11px] text-destructive">{error}</span>
					) : (
						variable.name !== "" && (
							<span className="text-[11px] text-muted-foreground">
								Reference it as{" "}
								<code className="text-foreground">${variable.name}</code> in widget
								filters and SQL.
							</span>
						)
					)}
				</div>
				<div className="flex flex-col gap-1.5">
					<Label className="text-xs">Label</Label>
					<Input
						size="sm"
						value={variable.label ?? ""}
						placeholder={variable.name || "Optional display label"}
						onChange={(event) => {
							const { label: _label, ...rest } = variable
							onChange(
								event.target.value === ""
									? rest
									: { ...rest, label: event.target.value },
							)
						}}
					/>
				</div>
			</div>

			<div className="grid grid-cols-2 gap-3">
				<div className="flex flex-col gap-1.5">
					<Label className="text-xs">Type</Label>
					<Select
						items={TYPE_OPTIONS}
						value={variable.type}
						onValueChange={(type) => {
							if (type === "query" || type === "custom" || type === "textbox") {
								onChange(withType(variable, type))
							}
						}}
					>
						<SelectTrigger className="h-8 text-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{Object.entries(TYPE_OPTIONS).map(([value, label]) => (
								<SelectItem key={value} value={value}>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label className="text-xs">Default value</Label>
					<Input
						size="sm"
						value={variable.defaultValue ?? ""}
						placeholder="Optional"
						onChange={(event) => {
							const { defaultValue: _defaultValue, ...rest } = variable
							onChange(
								event.target.value === ""
									? rest
									: { ...rest, defaultValue: event.target.value },
							)
						}}
					/>
				</div>
			</div>

			{variable.type === "query" && <QuerySourceFields variable={variable} onChange={onChange} />}

			{variable.type === "custom" && (
				<div className="flex flex-col gap-1.5">
					<Label className="text-xs">Options (comma-separated)</Label>
					<Textarea
						className="min-h-16 text-xs"
						value={variable.options.map((option) => option.value).join(", ")}
						placeholder="production, staging, development"
						onChange={(event) =>
							onChange({
								...variable,
								options: event.target.value
									.split(",")
									.map((value) => value.trim())
									.filter((value) => value.length > 0)
									.map((value) => ({ value })),
							})
						}
					/>
				</div>
			)}

			{variable.type !== "textbox" && (
				<div className="flex items-center justify-between">
					<div className="flex flex-col">
						<span className="text-xs font-medium">Include "All" option</span>
						<span className="text-[11px] text-muted-foreground">
							All drops the filter in query builders and expands to every value in SQL.
						</span>
					</div>
					<Switch
						checked={variable.includeAll === true}
						onCheckedChange={(checked) => {
							const { includeAll: _includeAll, ...rest } = variable
							onChange(checked ? { ...rest, includeAll: true } : rest)
						}}
					/>
				</div>
			)}
		</div>
	)
}

function QuerySourceFields({
	variable,
	onChange,
}: {
	variable: QueryVariable
	onChange: (variable: DashboardVariable) => void
}) {
	const source = variable.source
	return (
		<div className="grid grid-cols-2 gap-3">
			<div className="flex flex-col gap-1.5">
				<Label className="text-xs">Values from</Label>
				<Select
					items={{
						...Object.fromEntries(
							(Object.keys(FACET_LABELS) as QueryFacet[]).map((facet) => [
								`facet:${facet}`,
								FACET_LABELS[facet],
							]),
						),
						"attribute:span": "Span attribute…",
						"attribute:resource": "Resource attribute…",
					}}
					value={source.kind === "facet" ? `facet:${source.facet}` : `attribute:${source.scope}`}
					onValueChange={(value) => {
						if (typeof value !== "string") return
						const [kind, detail] = value.split(":")
						if (kind === "facet") {
							onChange({
								...variable,
								source: { kind: "facet", facet: detail as QueryFacet },
							})
						} else if (detail === "span" || detail === "resource") {
							onChange({
								...variable,
								source: {
									kind: "attribute",
									scope: detail,
									attributeKey: source.kind === "attribute" ? source.attributeKey : "",
								},
							})
						}
					}}
				>
					<SelectTrigger className="h-8 text-xs">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{(Object.keys(FACET_LABELS) as QueryFacet[]).map((facet) => (
							<SelectItem key={facet} value={`facet:${facet}`}>
								{FACET_LABELS[facet]}
							</SelectItem>
						))}
						<SelectItem value="attribute:span">Span attribute…</SelectItem>
						<SelectItem value="attribute:resource">Resource attribute…</SelectItem>
					</SelectContent>
				</Select>
			</div>
			{source.kind === "attribute" && (
				<div className="flex flex-col gap-1.5">
					<Label className="text-xs">Attribute key</Label>
					<Input
						size="sm"
						value={source.attributeKey}
						placeholder="http.route"
						onChange={(event) =>
							onChange({
								...variable,
								source: { ...source, attributeKey: event.target.value },
							})
						}
					/>
				</div>
			)}
		</div>
	)
}
