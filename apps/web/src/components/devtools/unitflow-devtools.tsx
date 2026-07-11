/**
 * A dev-only floating panel over the unitflow debug inspector (attached to the
 * shared runtime in `@/lib/models/runtime`). Two views:
 *
 *  - **Events** — the write/emit/instance log, grouped into causal transactions
 *    (a root publication and the writes/emits its synchronous dispatch caused,
 *    indented by depth) so you can see "what caused what". Filter flattens it.
 *  - **State** — the live snapshot: model instances (with lease counts) and
 *    every materialized/derived store value.
 *
 * Rendered only under `import.meta.env.DEV` (see `AppFrame`); polls the
 * inspector while open and unpaused. Nothing here runs in production.
 */

import { useCallback, useRef, useState } from "react"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/utils"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { getUnitflowInspector } from "@/lib/models/runtime"
import {
	buildCausalGroups,
	type DebugEvent,
	eventTypeMeta,
	filterEvents,
	formatInstanceKey,
	previewValue,
	safeStringify,
	type Snapshot,
} from "./unitflow-inspector-view"

const EMPTY_SNAPSHOT: Snapshot = { instances: [], stores: [] }
/** How many recent events to render (the buffer holds far more). */
const RENDER_LIMIT = 300
const POLL_MS = 500

const relativeTime = (delta: number): string => {
	if (delta < 1000) return `${Math.max(0, Math.round(delta))}ms`
	if (delta < 60_000) return `${(delta / 1000).toFixed(1)}s`
	return `${Math.floor(delta / 60_000)}m`
}

export function UnitflowDevtools() {
	const [open, setOpen] = useState(false)
	const [tab, setTab] = useState<"events" | "state">("events")
	const [paused, setPaused] = useState(false)
	const [filter, setFilter] = useState("")
	const [events, setEvents] = useState<ReadonlyArray<DebugEvent>>([])
	const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT)
	const [expandedEvents, setExpandedEvents] = useState<ReadonlySet<number>>(() => new Set())
	const [expandedStores, setExpandedStores] = useState<ReadonlySet<string>>(() => new Set())

	// Latest render values mirrored into refs so the mount-time poll closure
	// reads current open/paused without re-subscribing.
	const openRef = useRef(open)
	const pausedRef = useRef(paused)
	const lastSeqRef = useRef(-1)
	openRef.current = open
	pausedRef.current = paused

	const refresh = useCallback((force: boolean) => {
		const inspector = getUnitflowInspector()
		if (inspector === undefined) return
		const next = inspector.events()
		const newest = next.at(-1)?.seq ?? 0
		// Re-render only when a new publication landed (or on an explicit force),
		// so an idle registry doesn't churn React twice a second.
		if (!force && newest === lastSeqRef.current) return
		lastSeqRef.current = newest
		setEvents(next)
		setSnapshot(inspector.snapshot())
	}, [])

	useMountEffect(() => {
		const id = window.setInterval(() => {
			if (!openRef.current || pausedRef.current) return
			refresh(false)
		}, POLL_MS)
		return () => window.clearInterval(id)
	})

	const openPanel = () => {
		setPaused(false)
		setOpen(true)
		refresh(true)
	}

	const clearLog = () => {
		getUnitflowInspector()?.clear()
		lastSeqRef.current = -1
		setExpandedEvents(new Set())
		refresh(true)
	}

	const togglePause = () => {
		if (paused) refresh(true)
		setPaused(!paused)
	}

	const toggleEvent = (seq: number) =>
		setExpandedEvents((prev) => {
			const next = new Set(prev)
			if (next.has(seq)) next.delete(seq)
			else next.add(seq)
			return next
		})

	const toggleStore = (id: string) =>
		setExpandedStores((prev) => {
			const next = new Set(prev)
			if (next.has(id)) next.delete(id)
			else next.add(id)
			return next
		})

	if (!open) {
		return (
			<button
				type="button"
				onClick={openPanel}
				className="fixed right-3 bottom-3 z-[9999] flex items-center gap-1.5 rounded-full border bg-popover px-3 py-1.5 font-medium text-foreground text-xs shadow-md hover:bg-accent"
			>
				<span className="size-1.5 rounded-full bg-success" />
				unitflow
			</button>
		)
	}

	const now = Date.now()
	const groups = buildCausalGroups(events, RENDER_LIMIT)
	const flat = filterEvents(events, filter, RENDER_LIMIT)
	const filtering = filter.trim() !== ""

	const renderEventRow = (event: DebugEvent, depth: number) => {
		const meta = eventTypeMeta(event.type)
		const expanded = expandedEvents.has(event.seq)
		const hasValue = event.value !== undefined
		return (
			<li key={event.seq}>
				<button
					type="button"
					onClick={() => hasValue && toggleEvent(event.seq)}
					style={{ paddingLeft: `${8 + depth * 14}px` }}
					className={cn(
						"flex w-full items-center gap-2 py-1 pr-2 text-left hover:bg-accent/50",
						hasValue ? "cursor-pointer" : "cursor-default",
					)}
				>
					<span className="w-10 shrink-0 text-right text-muted-foreground tabular-nums">#{event.seq}</span>
					<Badge variant={meta.variant} size="sm" className="shrink-0">
						{meta.label}
					</Badge>
					<span className="truncate font-mono text-foreground">{event.name}</span>
					{hasValue && <span className="truncate font-mono text-muted-foreground">{previewValue(event.value)}</span>}
					<span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{relativeTime(now - event.time)}</span>
				</button>
				{expanded && hasValue && (
					<pre className="mx-2 mb-1 overflow-x-auto rounded border bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
						{safeStringify(event.value)}
					</pre>
				)}
			</li>
		)
	}

	return (
		<div className="fixed right-3 bottom-3 z-[9999] flex h-[70vh] max-h-[640px] w-[460px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-lg border bg-popover text-foreground text-xs shadow-xl">
			<div className="flex items-center gap-2 border-b px-3 py-2">
				<span className="size-1.5 rounded-full bg-success" />
				<span className="font-semibold">unitflow devtools</span>
				<div className="ml-2 flex gap-1 rounded-md bg-muted p-0.5">
					{(["events", "state"] as const).map((value) => (
						<button
							type="button"
							key={value}
							onClick={() => setTab(value)}
							className={cn(
								"rounded px-2 py-0.5 font-medium capitalize",
								tab === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
							)}
						>
							{value}
						</button>
					))}
				</div>
				<Button variant="ghost" size="xs" onClick={() => setOpen(false)} className="ml-auto">
					Close
				</Button>
			</div>

			{tab === "events" ? (
				<>
					<div className="flex items-center gap-2 border-b px-3 py-1.5">
						<input
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder="Filter by name or type…"
							className="h-6 flex-1 rounded border bg-background px-2 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
						/>
						<Button variant={paused ? "default" : "outline"} size="xs" onClick={togglePause}>
							{paused ? "Resume" : "Pause"}
						</Button>
						<Button variant="outline" size="xs" onClick={clearLog}>
							Clear
						</Button>
					</div>
					<div className="flex-1 overflow-y-auto">
						{events.length === 0 ? (
							<p className="p-4 text-center text-muted-foreground">
								No events yet. Interact with a model-backed page (e.g. /alerts) to record writes and emits.
							</p>
						) : filtering ? (
							<ul>{flat.map((event) => renderEventRow(event, 0))}</ul>
						) : (
							groups.map((group) => (
								<ul key={group.root} className="border-b border-border/50 last:border-0">
									{group.items.map(({ event, depth }) => renderEventRow(event, depth))}
								</ul>
							))
						)}
					</div>
					<div className="border-t px-3 py-1 text-muted-foreground">
						{events.length} events {paused && <span className="text-warning-foreground">· paused</span>}
					</div>
				</>
			) : (
				<div className="flex-1 overflow-y-auto">
					<section>
						<h3 className="sticky top-0 border-b bg-muted/60 px-3 py-1 font-semibold text-muted-foreground uppercase tracking-wide">
							Instances ({snapshot.instances.length})
						</h3>
						{snapshot.instances.length === 0 ? (
							<p className="px-3 py-2 text-muted-foreground">No live model instances.</p>
						) : (
							<ul>
								{snapshot.instances.map((instance) => {
									const key = formatInstanceKey(instance.key)
									return (
										<li key={`${instance.model}:${key}`} className="flex items-center gap-2 px-3 py-1">
											<span className="truncate font-mono text-foreground">{instance.model}</span>
											{key !== "" && <span className="truncate font-mono text-muted-foreground">{key}</span>}
											<Badge variant="secondary" size="sm" className="ml-auto shrink-0">
												{instance.leases} lease{instance.leases === 1 ? "" : "s"}
											</Badge>
										</li>
									)
								})}
							</ul>
						)}
					</section>
					<section>
						<h3 className="sticky top-0 border-b bg-muted/60 px-3 py-1 font-semibold text-muted-foreground uppercase tracking-wide">
							Stores ({snapshot.stores.length})
						</h3>
						{snapshot.stores.length === 0 ? (
							<p className="px-3 py-2 text-muted-foreground">No materialized stores.</p>
						) : (
							<ul>
								{snapshot.stores.map((store) => {
									const expanded = expandedStores.has(store.id)
									return (
										<li key={store.id}>
											<button
												type="button"
												onClick={() => toggleStore(store.id)}
												className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-accent/50"
											>
												<span className="truncate font-mono text-foreground">{store.name ?? store.id}</span>
												{store.derived && (
													<Badge variant="info" size="sm" className="shrink-0">
														derived
													</Badge>
												)}
												<span className="ml-auto truncate font-mono text-muted-foreground">{previewValue(store.value)}</span>
											</button>
											{expanded && (
												<pre className="mx-3 mb-1 overflow-x-auto rounded border bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
													{safeStringify(store.value)}
												</pre>
											)}
										</li>
									)
								})}
							</ul>
						)}
					</section>
				</div>
			)}
		</div>
	)
}
