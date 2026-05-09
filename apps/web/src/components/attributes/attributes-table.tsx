import { toast } from "sonner"
import { ChevronRightIcon } from "@/components/icons"
import { cn } from "@maple/ui/utils"
import { useClipboard } from "@maple/ui/hooks/use-clipboard"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@maple/ui/components/ui/collapsible"
import { CollapsibleJsonValue } from "./json-value"
import { groupAttributesByNamespace } from "@/lib/log-attributes"

export function CopyableValue({
	value,
	children,
	className,
}: {
	value: string
	children?: React.ReactNode
	className?: string
}) {
	const clipboard = useClipboard()

	return (
		<span
			className={cn(
				"cursor-pointer hover:bg-muted/50 rounded px-0.5 -mx-0.5 transition-colors",
				className,
			)}
			onClick={() => {
				clipboard.copy(value)
				toast.success("Copied to clipboard")
			}}
			title="Click to copy"
		>
			{children ?? value}
		</span>
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

function AttributeRow({ attrKey, value }: { attrKey: string; value: string }) {
	const parsed = tryParseJson(value)
	return (
		<div className="px-2 py-1.5">
			<div className="font-mono text-[11px] text-muted-foreground mb-0.5">
				<CopyableValue value={attrKey}>{attrKey}</CopyableValue>
			</div>
			<div className="font-mono text-xs break-all">
				{parsed !== null ? (
					<CollapsibleJsonValue value={value} parsed={parsed} />
				) : (
					<CopyableValue value={value}>{value}</CopyableValue>
				)}
			</div>
		</div>
	)
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
				<div className="space-y-1">
					<h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
					<div className="text-xs text-muted-foreground py-2">
						No {title.toLowerCase()} match "{searchQuery}"
					</div>
				</div>
			)
		}

		return (
			<div className="space-y-1">
				<h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
				<div className="space-y-1">
					{groups.map((group) => (
						<Collapsible
							key={group.namespace}
							defaultOpen={group.entries.length <= 8 || !!searchQuery}
						>
							<CollapsibleTrigger className="flex items-center gap-1 w-full text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors group p-1 rounded hover:bg-muted/40">
								<ChevronRightIcon
									size={10}
									className="transition-transform group-data-[panel-open]:rotate-90"
								/>
								<span className="font-semibold">{group.namespace}</span>
								<span className="text-muted-foreground/60">
									{group.namespace === "Other" ? "" : "."}
								</span>
								<span className="ml-auto text-[10px] text-muted-foreground/60">
									{group.entries.length}
								</span>
							</CollapsibleTrigger>
							<CollapsibleContent>
								<div className="rounded-md border divide-y mt-1 ml-2">
									{group.entries.map(([key, value]) => (
										<AttributeRow key={key} attrKey={key} value={value} />
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
			<div className="space-y-1">
				<h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
				<div className="text-xs text-muted-foreground py-2">
					No {title.toLowerCase()} match "{searchQuery}"
				</div>
			</div>
		)
	}

	return (
		<div className="space-y-1">
			<h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
			<div className="rounded-md border divide-y">
				{filtered.map(([key, value]) => (
					<AttributeRow key={key} attrKey={key} value={value} />
				))}
			</div>
		</div>
	)
}

function partitionResourceAttributes(attrs: Record<string, string>) {
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

export function ResourceAttributesSection({
	attributes,
	searchQuery,
	groupByNamespace,
}: {
	attributes: Record<string, string>
	searchQuery?: string
	groupByNamespace?: boolean
}) {
	const { standard, internal } = partitionResourceAttributes(attributes)
	const internalCount = Object.keys(internal).length

	return (
		<div className="space-y-2">
			<AttributesTable
				attributes={standard}
				title="Resource Attributes"
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
