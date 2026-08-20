import { useState } from "react"

import { MenuIcon, NetworkNodesIcon } from "@/components/icons"
import { SearchInput } from "@maple/ui/components/ui/search-input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { Toggle } from "@maple/ui/components/ui/toggle"
import { cn } from "@maple/ui/lib/utils"

import type { SessionSummary } from "@/lib/agent-sessions/session-summary"
import type { SessionTurn } from "@/lib/agent-sessions/session-turns"
import { SessionFlow } from "./session-flow"
import { SessionWaterfall } from "./session-waterfall"

/**
 * The two readings of the same spans, and the controls that shape them.
 *
 * Three things turn a plain waterfall into an agent view — turns, collapsed
 * idle, and hiding the app's own spans — and all three are toggles here rather
 * than assumptions, because each one is occasionally the thing you need to see.
 */
export function SessionViews({
	turns,
	summary,
}: {
	turns: readonly SessionTurn[]
	summary: SessionSummary
}) {
	const [query, setQuery] = useState("")
	const [agentSpansOnly, setAgentSpansOnly] = useState(true)
	const [collapseIdle, setCollapseIdle] = useState(true)
	const [mergeRepeats, setMergeRepeats] = useState(false)
	const [view, setView] = useState("trace")

	const counts = `${summary.spanCount.toLocaleString()} spans · ${turns.length} turns · ${summary.traceCount} traces`

	return (
		<Tabs
			value={view}
			onValueChange={(value) => setView(String(value))}
			className="flex h-full min-h-0 flex-col gap-0"
		>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-border border-b pb-2">
				<TabsList variant="underline" className="shrink-0">
					<TabsTrigger value="trace">
						<MenuIcon size={14} />
						Trace
					</TabsTrigger>
					<TabsTrigger value="flow">
						<NetworkNodesIcon size={14} />
						Flow
					</TabsTrigger>
				</TabsList>

				<div className="ml-auto flex flex-wrap items-center gap-2">
					{view === "trace" ? (
						<>
							<SearchInput
								value={query}
								onValueChange={setQuery}
								placeholder="Filter spans"
								className="w-56"
							/>
							<ViewChip pressed={agentSpansOnly} onPressedChange={setAgentSpansOnly}>
								Agent spans only
							</ViewChip>
							<ViewChip pressed={collapseIdle} onPressedChange={setCollapseIdle}>
								Collapse idle
							</ViewChip>
						</>
					) : (
						<ViewChip pressed={mergeRepeats} onPressedChange={setMergeRepeats}>
							Merge repeat tools
						</ViewChip>
					)}
					<span className="whitespace-nowrap text-muted-foreground text-xs tabular-nums">
						{counts}
					</span>
				</div>
			</div>

			<TabsContent value="trace" className="min-h-0 flex-1">
				<SessionWaterfall
					turns={turns}
					summary={summary}
					query={query}
					agentSpansOnly={agentSpansOnly}
					collapseIdle={collapseIdle}
				/>
			</TabsContent>
			<TabsContent value="flow" className="min-h-0 flex-1">
				<SessionFlow turns={turns} mergeRepeats={mergeRepeats} />
			</TabsContent>
		</Tabs>
	)
}

function ViewChip({
	pressed,
	onPressedChange,
	children,
}: {
	pressed: boolean
	onPressedChange: (pressed: boolean) => void
	children: string
}) {
	return (
		<Toggle
			variant="outline"
			size="sm"
			pressed={pressed}
			onPressedChange={onPressedChange}
			className="gap-1.5 rounded-full text-xs"
		>
			<span
				aria-hidden
				className={cn("size-1.5 rounded-full", pressed ? "bg-primary" : "bg-muted-foreground/40")}
			/>
			{children}
		</Toggle>
	)
}
