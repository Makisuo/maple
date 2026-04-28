import { useRef, useEffect } from "react"

export interface FeedEntry {
	time: string
	message: string
}

export function LiveFeedTerminal({ entries, status }: { entries: FeedEntry[]; status?: string }) {
	const scrollRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight
		}
	}, [entries.length])

	return (
		<div className="w-full max-w-xl rounded-xl border bg-card overflow-hidden font-mono text-xs">
			{/* Header */}
			<div className="flex items-center justify-between px-4 py-2.5 border-b">
				<div className="flex items-center gap-2">
					<span className="relative flex size-2">
						<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
						<span className="relative inline-flex size-2 rounded-full bg-primary" />
					</span>
					<span className="text-[11px] font-semibold uppercase tracking-widest text-foreground">
						Live
					</span>
				</div>
				<span className="text-muted-foreground text-[11px]">
					{status ?? "Waiting for first event..."}
				</span>
			</div>

			{/* Body */}
			<div ref={scrollRef} className="p-4 max-h-28 overflow-y-auto space-y-1.5">
				{entries.map((entry, i) => (
					<div key={i} className="flex gap-3 text-muted-foreground">
						<span className="text-muted-foreground/60 shrink-0 tabular-nums">{entry.time}</span>
						<span>{entry.message}</span>
						{i === entries.length - 1 && <span className="animate-pulse">_</span>}
					</div>
				))}
			</div>
		</div>
	)
}
