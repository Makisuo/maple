import { warmAtoms } from "@effect-router/core"
import type { ReactNode } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { QueryErrorState } from "@/components/common/query-error-state"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { LogHeroHeader } from "@/components/logs/log-hero-header"
import { LogMetaStrip } from "@/components/logs/log-meta-strip"
import { LogErrorBanner } from "@/components/logs/log-error-banner"
import { LogAttributesPanel } from "@/components/logs/log-attributes-panel"
import { LogRawPanel } from "@/components/logs/log-raw-panel"
import { LogTraceTimeline } from "@/components/logs/log-trace-timeline"
import { getLogResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { decodeLogKey, encodeLogKey, type LogKey } from "@/lib/log-key"
import type { GetLogInput, GetLogResult } from "@/api/warehouse/logs"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"

// Breadcrumb root shared by every state of this page.
const LOGS_BREADCRUMB = { label: "Logs", href: "/logs" } as const

/** A decoded LogKey carries empty strings for absent context; the query input wants undefined. */
function keyToInput(key: LogKey): GetLogInput {
	return {
		timestamp: key.timestamp,
		serviceName: key.serviceName,
		traceId: key.traceId || undefined,
		spanId: key.spanId || undefined,
	}
}

function bodyExcerpt(body: string): string {
	const trimmed = body.trim()
	return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed || "Log"
}

export const Route = createFileRoute("/logs/$logId")({
	component: LogDetailPage,
	loader: ({ context, params }) => {
		const key = decodeLogKey(params.logId)
		if (key) warmAtoms(context.effectRegistry, [getLogResultAtom({ data: keyToInput(key) })])
	},
})

/**
 * Standalone, shareable detail view for a single log. Every render path returns
 * a `DashboardLayout.Root` at the JSX root — keeping that element type stable
 * across the loading / error / success transitions lets React reconcile it in
 * place instead of tearing down (and rebuilding) the whole sidebar shell.
 */
function LogDetailPage() {
	const { logId } = Route.useParams()
	const navigate = useNavigate({ from: Route.fullPath })
	const { effectiveTimezone } = useTimezonePreference()

	const key = decodeLogKey(logId)
	const result = useAtomValue(
		key ? getLogResultAtom({ data: keyToInput(key) }) : disabledResultAtom<GetLogResult>(),
	)

	if (!key) {
		return (
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs items={[LOGS_BREADCRUMB, { label: "Not found" }]} />
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header
								title="Invalid log link"
								description="This log link is invalid or corrupted."
							/>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<NotFoundCard>
								<p className="text-sm text-muted-foreground">
									The link could not be decoded. Check that it was copied in full.
								</p>
							</NotFoundCard>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		)
	}

	return Result.builder(result)
		.onInitial(() => (
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs items={[LOGS_BREADCRUMB, { label: "Loading…" }]} />
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header title="Log detail" description="Loading log…" />
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<div className="flex flex-col gap-3">
								<Skeleton className="h-24 w-full rounded-md" />
								<div className="grid gap-3 lg:grid-cols-[1fr_minmax(360px,440px)]">
									<Skeleton className="h-64 w-full rounded-md" />
									<Skeleton className="h-64 w-full rounded-md" />
								</div>
							</div>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		))
		.onError((error) => (
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs items={[LOGS_BREADCRUMB, { label: "Error" }]} />
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header title="Log detail" description="Failed to load log" />
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<QueryErrorState error={error} titleOverride="Failed to load log" />
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		))
		.onSuccess(({ data: log }) => {
			if (!log) {
				return (
					<DashboardLayout.Root>
						<DashboardLayout.Breadcrumbs items={[LOGS_BREADCRUMB, { label: "Not found" }]} />
						<DashboardLayout.Body>
							<DashboardLayout.Content>
								<DashboardLayout.Sticky>
									<DashboardLayout.Header
										title="Log not found"
										description="This log could not be found — it may have aged out of retention."
									/>
								</DashboardLayout.Sticky>
								<DashboardLayout.Scroll>
									<NotFoundCard>
										<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
											<dt className="text-muted-foreground">Service</dt>
											<dd className="font-mono">{key.serviceName}</dd>
											<dt className="text-muted-foreground">Timestamp</dt>
											<dd className="font-mono">{key.timestamp}</dd>
										</dl>
									</NotFoundCard>
								</DashboardLayout.Scroll>
							</DashboardLayout.Content>
						</DashboardLayout.Body>
					</DashboardLayout.Root>
				)
			}

			const sev = log.severityText.toUpperCase()
			const showErrorBanner = sev === "ERROR" || sev === "FATAL"

			return (
				<DashboardLayout.Root>
					<DashboardLayout.Breadcrumbs
						items={[LOGS_BREADCRUMB, { label: bodyExcerpt(log.body) }]}
					/>
					<DashboardLayout.Body>
						<DashboardLayout.Content>
							<DashboardLayout.Sticky>
								<DashboardLayout.Header
									title="Log detail"
									description={`${log.serviceName} · ${formatTimestampInTimezone(
										log.timestamp,
										{
											timeZone: effectiveTimezone,
											withMilliseconds: true,
										},
									)}`}
								/>
							</DashboardLayout.Sticky>
							<DashboardLayout.Scroll>
								<div className="flex flex-col gap-3">
									{/* Hero + meta as one card, mirroring the drawer's stacked top section. */}
									<div className="overflow-hidden rounded-md border">
										<LogHeroHeader log={log} showClose={false} />
										<LogMetaStrip
											log={log}
											timeZone={effectiveTimezone}
											showOpenFullPage={false}
										/>
										{showErrorBanner && <LogErrorBanner log={log} />}
									</div>

									<div className="grid gap-3 lg:grid-cols-[1fr_minmax(360px,440px)]">
										<section className="rounded-md border p-3">
											<h2 className="mb-3 text-xs font-medium text-muted-foreground">
												Attributes
											</h2>
											<LogAttributesPanel log={log} />
										</section>

										<div className="flex flex-col gap-3">
											{log.traceId && (
												<section className="rounded-md border p-3">
													<LogTraceTimeline
														currentLog={log}
														onLogSelect={(next) =>
															navigate({
																to: "/logs/$logId",
																params: { logId: encodeLogKey(next) },
															})
														}
													/>
												</section>
											)}
											<section className="rounded-md border p-3">
												<LogRawPanel log={log} />
											</section>
										</div>
									</div>
								</div>
							</DashboardLayout.Scroll>
						</DashboardLayout.Content>
					</DashboardLayout.Body>
				</DashboardLayout.Root>
			)
		})
		.render()
}

/** Centered dashed-border card used by both not-found states, with a way back to the list. */
function NotFoundCard({ children }: { children: ReactNode }) {
	return (
		<div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed p-12 text-center">
			{children}
			<Link
				to="/logs"
				className="text-sm text-primary underline underline-offset-4 hover:text-primary/80"
			>
				Back to Logs
			</Link>
		</div>
	)
}
