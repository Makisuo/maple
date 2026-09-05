import { useMemo, useState } from "react"
import { useRouter } from "@tanstack/react-router"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { CheckIcon, LayersIcon } from "@/components/icons"
import {
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { Input } from "@maple/ui/components/ui/input"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { getServicesFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { setGlobalNamespace } from "@/lib/services/common/global-namespace"
import { snapRangeForCache } from "@/lib/time-utils"
import { useGlobalNamespace } from "@/hooks/use-global-namespace"

/** Search only earns its row once the list is long enough to need it. */
const SEARCH_THRESHOLD = 8

/**
 * The searchable namespace list itself — the submenu's content for the Clerk
 * switcher, rendered directly as the menu body for the self-hosted one.
 * Mounted only when its menu (or submenu) opens, so the facets probe is lazy.
 */
function NamespaceScopeList({ emptyNotice = false }: { emptyNotice?: boolean }) {
	const router = useRouter()
	const pinned = useGlobalNamespace()
	const [query, setQuery] = useState("")

	// Same snapped 24h probe the overview and service map run, so all three
	// share one cache entry. Deliberately NOT namespace-pinned — this list is
	// how the pin is escaped.
	const facetsRange = useMemo(() => {
		const end = Date.now()
		return snapRangeForCache({
			startTime: formatWarehouseDateTime(end - 24 * 60 * 60 * 1000),
			endTime: formatWarehouseDateTime(end),
		})
	}, [])
	const facetsResult = useAtomValue(getServicesFacetsResultAtom({ data: facetsRange }))

	const loading = !Result.isSuccess(facetsResult) && !Result.isFailure(facetsResult)
	const observed = Result.isSuccess(facetsResult)
		? facetsResult.value.data.namespaces.filter((item) => item.name !== "")
		: []
	const pinnedIsObserved = pinned === null || observed.some((item) => item.name === pinned)

	const trimmed = query.trim().toLowerCase()
	const matches =
		trimmed === "" ? observed : observed.filter((item) => item.name.toLowerCase().includes(trimmed))

	const select = (namespace: string | null) => {
		setGlobalNamespace(namespace)
		// Loaders re-run and the keyed Outlet in __root remounts the page tree,
		// so every query input is rebuilt under the new scope.
		void router.invalidate()
	}

	if (loading && observed.length === 0) {
		return <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading namespaces…</div>
	}
	if (observed.length === 0 && pinned === null) {
		return emptyNotice ? (
			<div className="px-2 py-1.5 text-xs text-muted-foreground">No namespaces detected</div>
		) : null
	}

	return (
		<>
			{observed.length >= SEARCH_THRESHOLD && (
				<div className="p-1 pb-1.5">
					<Input
						autoFocus
						placeholder="Search namespaces…"
						size="sm"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						// The menu's typeahead would otherwise swallow keystrokes and
						// jump highlight to matching items while typing here.
						onKeyDown={(e) => e.stopPropagation()}
					/>
				</div>
			)}
			<div className="max-h-72 overflow-y-auto">
				{trimmed === "" && (
					<DropdownMenuItem onClick={() => select(null)}>
						<span className="truncate">All namespaces</span>
						{pinned === null && <CheckIcon size={16} className="ml-auto" />}
					</DropdownMenuItem>
				)}
				{matches.map((item) => (
					<DropdownMenuItem key={item.name} onClick={() => select(item.name)}>
						<span className="truncate">{item.name}</span>
						{pinned === item.name && <CheckIcon size={16} className="ml-auto" />}
					</DropdownMenuItem>
				))}
				{matches.length === 0 && trimmed !== "" && (
					<div className="px-2 py-1.5 text-xs text-muted-foreground">No namespaces match</div>
				)}
				{!pinnedIsObserved &&
					pinned !== null &&
					(trimmed === "" || pinned.toLowerCase().includes(trimmed)) && (
						<DropdownMenuItem onClick={() => select(pinned)}>
							<span className="truncate">{pinned}</span>
							<span className="ml-2 text-xs text-muted-foreground">no recent data</span>
							<CheckIcon size={16} className="ml-auto" />
						</DropdownMenuItem>
					)}
			</div>
		</>
	)
}

/**
 * "Namespace ▸" submenu row for the Clerk org switcher. The current scope
 * reads directly on the trigger so the pin is visible without opening it.
 */
export function NamespaceScopeSubmenu() {
	const pinned = useGlobalNamespace()

	return (
		<>
			<DropdownMenuSeparator />
			<DropdownMenuSub>
				<DropdownMenuSubTrigger>
					<LayersIcon size={14} />
					Namespace
					<span className="ml-auto max-w-32 truncate pl-4 text-xs text-muted-foreground">
						{pinned ?? "All"}
					</span>
				</DropdownMenuSubTrigger>
				<DropdownMenuSubContent className="min-w-52">
					<NamespaceScopeList />
				</DropdownMenuSubContent>
			</DropdownMenuSub>
		</>
	)
}

/** Flat variant for the self-hosted switcher, where the menu holds nothing else. */
export function NamespaceScopeMenuGroup({ emptyNotice = false }: { emptyNotice?: boolean }) {
	return (
		<DropdownMenuGroup>
			<DropdownMenuLabel>Namespace</DropdownMenuLabel>
			<NamespaceScopeList emptyNotice={emptyNotice} />
		</DropdownMenuGroup>
	)
}
