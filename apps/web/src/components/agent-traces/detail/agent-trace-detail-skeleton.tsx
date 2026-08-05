import { Skeleton } from "@maple/ui/components/ui/skeleton"

/** Mirrors the loaded layout box for box, so the page doesn't reflow when the two queries land. */
export function AgentTraceDetailSkeleton() {
	return (
		<div className="flex flex-col gap-6 xl:flex-row">
			<div className="flex min-w-0 grow flex-col gap-6">
				<div className="flex flex-col gap-2.5">
					<Skeleton className="h-3 w-48" />
					<Skeleton className="h-7 w-2/3" />
					<Skeleton className="h-5 w-80" />
				</div>
				<div className="flex flex-wrap gap-6">
					{[0, 1, 2, 3, 4].map((index) => (
						<div key={index} className="flex flex-col gap-2">
							<Skeleton className="h-3 w-16" />
							<Skeleton className="h-4 w-28" />
						</div>
					))}
				</div>
				<Skeleton className="h-6 w-full rounded-md" />
				<Skeleton className="h-24 w-full rounded-lg" />
				<div className="flex flex-col gap-6">
					{[0, 1, 2].map((index) => (
						<div key={index} className="flex gap-3.5">
							<Skeleton className="h-3 w-10 shrink-0" />
							<Skeleton className="size-2.5 shrink-0 rounded-[3px]" />
							<div className="flex min-w-0 grow flex-col gap-2">
								<Skeleton className="h-3 w-56" />
								<Skeleton className="h-4 w-full" />
								<Skeleton className="h-4 w-4/5" />
							</div>
						</div>
					))}
				</div>
			</div>
			<Skeleton className="h-96 w-full rounded-lg xl:w-80 xl:shrink-0" />
		</div>
	)
}
