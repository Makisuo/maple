// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
"use client"

import { ChevronRightIcon } from "../icons"
import { cn } from "../../lib/utils"
import { useCopy } from "../../hooks/use-copy"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "../ui/collapsible"
import { groupAttributesByNamespace } from "../../lib/log-attributes"
import { CollapsibleJsonValue } from "./json-value"
import { useAttributesConfig } from "./context"

/**
 * Inline attribute text that copies itself. A real `<button>`, so it's keyboard
 * reachable and announced.
 *
 * This toasts. There's no room beside inline text for a status glyph, and an
 * attributes table holds dozens of these — a per-row `Tooltip` would be a real
 * cost on a hot path. A `title` can't carry the feedback either: the pointer
 * hasn't moved when you click, so the native tooltip never re-shows. The
 * transient tint is a bonus for the row you actually clicked; the toast is what
 * you're meant to see.
 */
export function CopyableValue({
	value,
	label,
	children,
	className,
}: {
	value: string
	/** Names the thing in the `aria-label` and the toast, e.g. the attribute key. */
	label?: string
	children?: React.ReactNode
	className?: string
}) {
	const { copy, status } = useCopy({ label })

	return (
		<button
			type="button"
			aria-label={`Copy ${label ?? "value"}`}
			className={cn(
				"-mx-0.5 cursor-pointer rounded px-0.5 text-left transition-colors",
				// The settled state has to win over `hover:` — you are, by definition,
				// hovering the thing you just clicked.
				status === "idle" && "hover:bg-muted/50",
				status === "copied" && "bg-severity-info/20",
				status === "error" && "bg-destructive/20",
				className,
			)}
			onClick={(event) => {
				event.stopPropagation()
				void copy(value)
			}}
			title="Click to copy"
		>
			{children ?? value}
		</button>
	)
}

export function tryParseJson(value: string): unknown | null {
	const trimmed = value.trimStart()
	if (trimmed[0] !== "{" && trimmed[0] !== "[") return null
	try {
		return JSON.parse(value)
	} catch {
		return null
	}
}

function AttributeRow({
	attrKey,
	value,
	displayKey,
}: {
	attrKey: string
	value: string
	/** Label shown in the key column; defaults to `attrKey`. Copies still use the full `attrKey`. */
	displayKey?: string
}) {
	const { renderValue } = useAttributesConfig()
	const parsed = tryParseJson(value)
	// Only non-JSON values are overridable; JSON keeps its collapsible renderer.
	const override = parsed === null ? renderValue?.(attrKey, value) : null
	return (
		<div className="grid grid-cols-[minmax(7rem,38%)_1fr] items-start gap-x-3 px-2 py-1 transition-colors hover:bg-muted/40">
			<CopyableValue
				value={attrKey}
				label="attribute key"
				className="font-mono text-[11px] leading-relaxed text-muted-foreground break-words"
			>
				{displayKey ?? attrKey}
			</CopyableValue>
			<div className="min-w-0 font-mono text-[11px] leading-relaxed text-foreground break-all">
				{parsed !== null ? (
					<CollapsibleJsonValue value={value} parsed={parsed} />
				) : override != null ? (
					override
				) : (
					<CopyableValue value={value} label={attrKey}>
						{value}
					</CopyableValue>
				)}
			</div>
		</div>
	)
}

/**
 * Drops the namespace prefix from a key for display inside its group
 * (e.g. `k8s.pod.name` → `pod.name` under the `k8s` header). The group header
 * already names the namespace, so the leaf is enough — and it keeps the key
 * column tight. Returns the full key unchanged for the synthetic `Other` group
 * or anything that doesn't actually start with `namespace.`.
 */
function stripNamespace(key: string, namespace: string): string {
	if (namespace === "Other") return key
	const prefix = `${namespace}.`
	return key.startsWith(prefix) ? key.slice(prefix.length) : key
}

function filterEntries(entries: Array<[string, string]>, searchQuery?: string): Array<[string, string]> {
	if (!searchQuery) return entries
	const q = searchQuery.toLowerCase()
	return entries.filter(([key, value]) => key.toLowerCase().includes(q) || value.toLowerCase().includes(q))
}

export interface AttributesTableProps {
	attributes: Record<string, string>
	title: string
	searchQuery?: string
	groupByNamespace?: boolean
}

export function AttributesTable({ attributes, title, searchQuery, groupByNamespace }: AttributesTableProps) {
	const allEntries = Object.entries(attributes)

	if (allEntries.length === 0) {
		return <div className="text-xs text-muted-foreground py-2">No {title.toLowerCase()} available</div>
	}

	if (groupByNamespace) {
		const groups = groupAttributesByNamespace(attributes)
			.map((group) => ({ ...group, entries: filterEntries(group.entries, searchQuery) }))
			.filter((group) => group.entries.length > 0)

		if (groups.length === 0) {
			return (
				<div className="space-y-1.5">
					<h4 className="text-xs font-medium tracking-wide text-foreground/70">{title}</h4>
					<div className="text-xs text-muted-foreground py-2">
						No {title.toLowerCase()} match "{searchQuery}"
					</div>
				</div>
			)
		}

		return (
			<div className="space-y-1.5">
				<h4 className="text-xs font-medium tracking-wide text-foreground/70">{title}</h4>
				<div className="divide-y divide-border/60 overflow-hidden rounded-md border">
					{groups.map((group) => (
						<Collapsible
							key={group.namespace}
							defaultOpen={group.entries.length <= 8 || !!searchQuery}
						>
							<CollapsibleTrigger className="group flex w-full items-center gap-1.5 px-1.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground">
								<ChevronRightIcon
									size={11}
									className="transition-transform group-data-[panel-open]:rotate-90"
								/>
								<span className="font-mono font-semibold text-foreground/80">
									{group.namespace}
								</span>
								<span className="ml-auto rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
									{group.entries.length}
								</span>
							</CollapsibleTrigger>
							<CollapsibleContent>
								<div className="divide-y divide-border/40 border-t border-border/60 bg-muted/15">
									{group.entries.map(([key, value]) => (
										<AttributeRow
											key={key}
											attrKey={key}
											value={value}
											displayKey={stripNamespace(key, group.namespace)}
										/>
									))}
								</div>
							</CollapsibleContent>
						</Collapsible>
					))}
				</div>
			</div>
		)
	}

	const filtered = filterEntries(allEntries, searchQuery)

	if (filtered.length === 0) {
		return (
			<div className="space-y-1.5">
				<h4 className="text-xs font-medium tracking-wide text-foreground/70">{title}</h4>
				<div className="text-xs text-muted-foreground py-2">
					No {title.toLowerCase()} match "{searchQuery}"
				</div>
			</div>
		)
	}

	return (
		<div className="space-y-1.5">
			<h4 className="text-xs font-medium tracking-wide text-foreground/70">{title}</h4>
			<div className="divide-y divide-border/60 overflow-hidden rounded-md border">
				{filtered.map(([key, value]) => (
					<AttributeRow key={key} attrKey={key} value={value} />
				))}
			</div>
		</div>
	)
}

/**
 * Splits Maple's own attributes (the `maple_` namespace the gateway stamps —
 * `maple_org_id`, `maple_ai.*`, …) out of whatever the instrumentation sent.
 * They're useful when you go looking, and noise when you don't, so they get
 * their own collapsed section instead of a row among the customer's own keys.
 */
function partitionInternalAttributes(attrs: Record<string, string>) {
	const standard: Record<string, string> = {}
	const internal: Record<string, string> = {}
	for (const [key, value] of Object.entries(attrs)) {
		if (key.startsWith("maple_")) {
			internal[key] = value
		} else {
			standard[key] = value
		}
	}
	return { standard, internal }
}

/**
 * An `AttributesTable` with the `maple_` keys folded into a collapsed
 * "Maple Internal" table beneath it. Use this anywhere a raw attribute map from
 * the pipeline is shown — span, resource, or log — since any of them can carry
 * gateway-stamped keys.
 */
export function AttributesSection({
	attributes,
	title,
	searchQuery,
	groupByNamespace,
}: AttributesTableProps) {
	const { standard, internal } = partitionInternalAttributes(attributes)
	const internalCount = Object.keys(internal).length

	return (
		<div className="space-y-2">
			<AttributesTable
				attributes={standard}
				title={title}
				searchQuery={searchQuery}
				groupByNamespace={groupByNamespace}
			/>
			{internalCount > 0 && (
				<Collapsible>
					<CollapsibleTrigger className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors group">
						<ChevronRightIcon
							size={10}
							className="transition-transform group-data-[panel-open]:rotate-90"
						/>
						Maple Internal ({internalCount})
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div className="mt-1">
							<AttributesTable
								attributes={internal}
								title="Maple Internal"
								searchQuery={searchQuery}
							/>
						</div>
					</CollapsibleContent>
				</Collapsible>
			)}
		</div>
	)
}

export function ResourceAttributesSection({
	attributes,
	searchQuery,
	groupByNamespace,
}: Omit<AttributesTableProps, "title">) {
	return (
		<AttributesSection
			attributes={attributes}
			title="Resource Attributes"
			searchQuery={searchQuery}
			groupByNamespace={groupByNamespace}
		/>
	)
}
