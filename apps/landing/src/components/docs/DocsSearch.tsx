import {
	Command,
	CommandDialog,
	CommandDialogPopup,
	CommandEmpty,
	CommandFooter,
	CommandGroup,
	CommandGroupLabel,
	CommandInput,
	CommandItem,
	CommandList,
} from "@maple/ui/components/ui/command"
import { isEditableTarget } from "@maple/ui/lib/keyboard"
import { MagnifierIcon } from "@maple/ui/components/icons/magnifier"
import Fuse, { type IFuseOptions } from "fuse.js"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { SearchDoc } from "../../lib/docs-search"
import { trackLanding } from "../../lib/telemetry"

/** Flat browse order — mirrors the sidebar group order (DocsSidebar.astro). */
const GROUP_ORDER = [
	"Getting Started",
	"Concepts",
	"Infrastructure",
	"Integrations",
	"Local Mode",
	"Effect SDK",
	"Platforms",
	"Instrumentation",
]

const MAX_RESULTS = 8

const FUSE_OPTIONS: IFuseOptions<SearchDoc> = {
	keys: [
		{ name: "title", weight: 0.5 },
		{ name: "headings", weight: 0.25 },
		{ name: "description", weight: 0.15 },
		{ name: "content", weight: 0.1 },
	],
	ignoreLocation: true,
	threshold: 0.35,
	minMatchCharLength: 2,
}

// Module-scoped so the index is fetched + built at most once per page session.
let indexPromise: Promise<{ fuse: Fuse<SearchDoc>; docs: SearchDoc[] }> | null = null

function loadIndex() {
	if (!indexPromise) {
		indexPromise = fetch("/docs/search-index.json")
			.then((res) => res.json() as Promise<SearchDoc[]>)
			.then((docs) => ({ fuse: new Fuse(docs, FUSE_OPTIONS), docs }))
			.catch((err) => {
				indexPromise = null // allow retry on next open
				throw err
			})
	}
	return indexPromise
}

function groupOrder(group: string): number {
	const i = GROUP_ORDER.indexOf(group)
	return i === -1 ? 999 : i
}

function groupDocs(docs: SearchDoc[]): [string, SearchDoc[]][] {
	const groups = new Map<string, SearchDoc[]>()
	for (const doc of docs) {
		const list = groups.get(doc.group)
		if (list) list.push(doc)
		else groups.set(doc.group, [doc])
	}
	return [...groups.entries()].sort((a, b) => groupOrder(a[0]) - groupOrder(b[0]))
}

function ResultItem({ doc }: { doc: SearchDoc }) {
	// Inherit the item's text color (the base component flips it to the dark
	// accent-foreground when highlighted) and lean on opacity for hierarchy, so
	// both states stay legible — fixed fg/fg-muted colors clash on the amber row.
	return (
		<CommandItem value={doc.url} render={<a href={doc.url} />} className="flex items-center gap-3">
			<span className="flex min-w-0 flex-col">
				<span className="truncate text-sm">{doc.title}</span>
				<span className="truncate text-xs opacity-65">{doc.description}</span>
			</span>
			<span className="ms-auto shrink-0 whitespace-nowrap border border-current/25 px-1.5 py-0.5 font-medium text-[9px] text-current/70 uppercase leading-none tracking-wider">
				{doc.sdk ?? doc.group}
			</span>
		</CommandItem>
	)
}

export default function DocsSearch() {
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState("")
	const [docs, setDocs] = useState<SearchDoc[]>([])
	const fuseRef = useRef<Fuse<SearchDoc> | null>(null)

	const ensureIndex = useCallback(() => {
		loadIndex()
			.then(({ fuse, docs: loaded }) => {
				fuseRef.current = fuse
				setDocs(loaded)
			})
			.catch(() => {
				/* keep palette usable; results just stay empty */
			})
	}, [])

	// `openRef` mirrors `open` so the mount-only key listener reads fresh state.
	const openRef = useRef(false)
	// Same reason: the close handler needs the final query, and it is created once.
	const queryRef = useRef("")
	const setPaletteOpen = useCallback(
		(next: boolean) => {
			openRef.current = next
			setOpen(next)
			if (next) {
				ensureIndex()
				return
			}
			// Emitted on close rather than per keystroke: what's worth knowing is
			// what someone searched for, not every prefix they typed on the way.
			const searched = queryRef.current.trim()
			if (searched) trackLanding("docs_search", { query: searched.slice(0, 120) })
			queryRef.current = ""
			setQuery("")
		},
		[ensureIndex],
	)

	// Mount once: prefetch the index (instant first open) + global shortcuts.
	useEffect(() => {
		ensureIndex()
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.key === "k" || event.key === "K") && (event.metaKey || event.ctrlKey)) {
				event.preventDefault()
				setPaletteOpen(!openRef.current)
			} else if (event.key === "/" && !openRef.current && !isEditableTarget(event.target)) {
				event.preventDefault()
				setPaletteOpen(true)
			} else if (event.key === "Escape" && openRef.current) {
				// The forced-open Autocomplete stopPropagation()s Escape before the Dialog
				// sees it, so close here from the capture phase.
				setPaletteOpen(false)
			}
		}
		// Capture phase so ⌘K still toggles while focus is trapped in the open dialog.
		document.addEventListener("keydown", onKeyDown, true)
		return () => document.removeEventListener("keydown", onKeyDown, true)
	}, [ensureIndex, setPaletteOpen])

	// `null` => browse mode (empty query); otherwise the ranked Fuse hits.
	const results = useMemo<SearchDoc[] | null>(() => {
		const trimmed = query.trim()
		if (!trimmed) return null
		const fuse = fuseRef.current
		if (!fuse) return []
		return fuse.search(trimmed, { limit: MAX_RESULTS }).map((r) => r.item)
	}, [query, docs])

	const grouped = useMemo(() => groupDocs(docs), [docs])

	return (
		<>
			<button
				type="button"
				onClick={() => setPaletteOpen(true)}
				aria-label="Search docs"
				className="flex h-7 items-center gap-2 border border-border px-2 text-fg-muted text-xs transition-colors hover:border-fg-muted/50 hover:text-fg"
			>
				<MagnifierIcon className="size-3.5" />
				<span className="hidden sm:inline">Search docs</span>
				<kbd className="hidden font-medium text-[10px] text-fg-muted/70 tracking-widest sm:inline">
					⌘K
				</kbd>
			</button>

			{/* Gate the popup on `open` so it unmounts cleanly — base-ui leaves the
			    backdrop mounted (pointer-events: auto) when the forced-open Autocomplete
			    inside holds focus through the close, which would block the page. */}
			<CommandDialog open={open} onOpenChange={setPaletteOpen}>
				{open && (
					<CommandDialogPopup>
						<Command
							inline={false}
							filter={null}
							value={query}
							onValueChange={(value: string) => {
								queryRef.current = value
								setQuery(value)
							}}
						>
							<CommandInput placeholder="Search the docs…" />
							<CommandList>
								{results === null ? (
									grouped.map(([group, items]) => (
										<CommandGroup key={group}>
											<CommandGroupLabel>{group}</CommandGroupLabel>
											{items.map((doc) => (
												<ResultItem key={doc.id} doc={doc} />
											))}
										</CommandGroup>
									))
								) : results.length === 0 ? (
									<CommandEmpty>No results for “{query}”.</CommandEmpty>
								) : (
									results.map((doc) => <ResultItem key={doc.id} doc={doc} />)
								)}
							</CommandList>
							<CommandFooter>
								<span className="flex items-center gap-1.5">
									<kbd className="font-medium text-fg-muted/70">↵</kbd> to open
								</span>
								<span className="flex items-center gap-1.5">
									<kbd className="font-medium text-fg-muted/70">esc</kbd> to close
								</span>
							</CommandFooter>
						</Command>
					</CommandDialogPopup>
				)}
			</CommandDialog>
		</>
	)
}
