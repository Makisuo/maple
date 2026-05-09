import { Result } from "@/lib/effect-atom"
import { Fragment, useState } from "react"
import { Link } from "@tanstack/react-router"
import { formatDistanceToNow, format } from "date-fns"
import { ArrowRightIcon, ChevronDownIcon, ChevronRightIcon } from "@/components/icons"

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { type GetErrorsByTypeInput, type ErrorByType } from "@/api/tinybird/errors"
import { formatDuration } from "@/lib/format"
import { QueryErrorState } from "@/components/common/query-error-state"
import {
	getErrorDetailTracesResultAtom,
	getErrorsByTypeResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import { HttpSpanLabel } from "@/components/traces/http-span-label"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"

function formatNumber(num: number): string {
	if (num >= 1_000_000) {
		return `${(num / 1_000_000).toFixed(1)}M`
	}
	if (num >= 1_000) {
		return `${(num / 1_000).toFixed(1)}K`
	}
	return num.toLocaleString()
}

function formatTimeAgo(date: Date): string {
	return formatDistanceToNow(date, { addSuffix: true })
}

function truncateErrorType(errorType: string, maxLength = 60): string {
	if (errorType.length <= maxLength) return errorType
	return `${errorType.slice(0, maxLength)}...`
}

interface ErrorsByTypeTableProps {
	filters: GetErrorsByTypeInput
}

function ErrorDetailPanel({ errorRow, filters }: { errorRow: ErrorByType; filters: GetErrorsByTypeInput }) {
	const detailResult = useRefreshableAtomValue(
		getErrorDetailTracesResultAtom({
			data: {
				errorType: errorRow.errorType,
				startTime: filters.startTime,
				endTime: filters.endTime,
				services: filters.services,
				limit: 5,
			},
		}),
	)

	return (
		<div className="px-6 py-4 space-y-4 bg-muted/30">
			<div className="space-y-3">
				<div>
					<p className="text-xs font-medium text-muted-foreground mb-1">Error Message</p>
					<pre className="text-sm font-mono whitespace-pre-wrap break-all bg-background border rounded-md p-3">
						{errorRow.sampleMessage}
					</pre>
				</div>

				<div className="grid grid-cols-2 gap-4">
					<div>
						<p className="text-xs font-medium text-muted-foreground mb-1">First Seen</p>
						<p className="text-sm">{format(errorRow.firstSeen, "MMM d, yyyy HH:mm:ss")}</p>
					</div>
					<div>
						<p className="text-xs font-medium text-muted-foreground mb-1">Last Seen</p>
						<p className="text-sm">{format(errorRow.lastSeen, "MMM d, yyyy HH:mm:ss")}</p>
					</div>
				</div>

				{Result.builder(detailResult)
					.onSuccess((response) => {
						const allServices = [
							...new Set((response.data ?? []).flatMap((t) => t.services ?? [])),
						]
						if (allServices.length === 0) return null
						return (
							<div>
								<p className="text-xs font-medium text-muted-foreground mb-1">
									Affected Services
								</p>
								<div className="flex flex-wrap gap-1.5">
									{allServices.map((service) => (
										<Badge key={service} variant="outline" className="text-xs">
											{service}
										</Badge>
									))}
								</div>
							</div>
						)
					})
					.render()}
			</div>

			<div>
				<div className="flex items-center justify-between mb-2">
					<p className="text-xs font-medium text-muted-foreground">Sample Traces</p>
					<Link
						to="/traces"
						search={{
							hasError: true,
							startTime: filters.startTime,
							endTime: filters.endTime,
						}}
						className="text-xs text-primary hover:underline"
					>
						View all traces
					</Link>
				</div>

				{Result.builder(detailResult)
					.onInitial(() => (
						<div className="space-y-2">
							{Array.from({ length: 3 }).map((_, i) => (
								<Skeleton key={i} className="h-10 w-full" />
							))}
						</div>
					))
					.onError(() => <p className="text-sm text-muted-foreground">No sample traces found</p>)
					.onSuccess((response) => {
						const traces = response.data ?? []
						if (traces.length === 0) {
							return <p className="text-sm text-muted-foreground">No sample traces found</p>
						}

						return (
							<div className="rounded-md border bg-background divide-y">
								{traces.map((trace) => (
									<Link
										key={trace.traceId}
										to="/traces/$traceId"
										params={{ traceId: trace.traceId }}
										search={{ t: trace.startTime.toISOString() }}
										className="flex items-center justify-between px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
									>
										<div className="flex items-center gap-3 min-w-0">
											<span className="font-mono text-xs text-muted-foreground shrink-0">
												{trace.traceId.slice(0, 8)}
											</span>
											<HttpSpanLabel spanName={trace.rootSpanName} />
										</div>
										<div className="flex items-center gap-4 shrink-0 text-muted-foreground">
											<span className="text-xs">
												{trace.spanCount} span
												{Number(trace.spanCount) !== 1 ? "s" : ""}
											</span>
											<span className="text-xs">
												{formatDuration(trace.durationMicros / 1000)}
											</span>
											<span className="text-xs">{formatTimeAgo(trace.startTime)}</span>
										</div>
									</Link>
								))}
							</div>
						)
					})
					.render()}
			</div>

			<div className="pt-1">
				<Link
					to="/errors/$errorType"
					params={{ errorType: encodeURIComponent(errorRow.errorType) }}
					className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
				>
					View full details
					<ArrowRightIcon size={12} />
				</Link>
			</div>
		</div>
	)
}

function LoadingState() {
	return (
		<div className="space-y-4">
			<div className="rounded-md border overflow-auto">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead className="w-[32px]" />
							<TableHead>Error Type</TableHead>
							<TableHead className="w-[100px]">Count</TableHead>
							<TableHead className="hidden md:table-cell w-[140px]">
								Affected Services
							</TableHead>
							<TableHead className="hidden md:table-cell w-[140px]">Last Seen</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{Array.from({ length: 5 }).map((_, i) => (
							<TableRow key={i}>
								<TableCell />
								<TableCell>
									<Skeleton className="h-4 w-64" />
								</TableCell>
								<TableCell>
									<Skeleton className="h-5 w-16" />
								</TableCell>
								<TableCell className="hidden md:table-cell">
									<Skeleton className="h-4 w-20" />
								</TableCell>
								<TableCell className="hidden md:table-cell">
									<Skeleton className="h-4 w-24" />
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</div>
	)
}

export function ErrorsByTypeTable({ filters }: ErrorsByTypeTableProps) {
	const [expandedError, setExpandedError] = useState<string | null>(null)

	const errorsResult = useRefreshableAtomValue(getErrorsByTypeResultAtom({ data: filters }))

	return Result.builder(errorsResult)
		.onInitial(() => <LoadingState />)
		.onError((error) => <QueryErrorState error={error} />)
		.onSuccess((response, result) => {
			const errors = response.data ?? []

			const toggleExpanded = (errorType: string) => {
				setExpandedError((prev) => (prev === errorType ? null : errorType))
			}

			return (
				<div className={`space-y-4 ${result.waiting ? "opacity-60" : ""}`}>
					<div className="rounded-md border overflow-auto">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="w-[32px]" />
									<TableHead>Error Type</TableHead>
									<TableHead className="w-[100px]">Count</TableHead>
									<TableHead className="hidden md:table-cell w-[140px]">
										Affected Services
									</TableHead>
									<TableHead className="hidden md:table-cell w-[140px]">
										Last Seen
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{errors.length === 0 ? (
									<TableRow>
										<TableCell colSpan={5} className="h-24 text-center">
											No errors found in the selected time range
										</TableCell>
									</TableRow>
								) : (
									errors.map((errorRow: ErrorByType) => {
										const isExpanded = expandedError === errorRow.errorType
										return (
											<Fragment key={errorRow.errorType}>
												<TableRow
													className="cursor-pointer hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
													tabIndex={0}
													aria-expanded={isExpanded}
													onClick={() => toggleExpanded(errorRow.errorType)}
													onKeyDown={(e) => {
														if (e.key === "Enter" || e.key === " ") {
															e.preventDefault()
															toggleExpanded(errorRow.errorType)
														}
													}}
												>
													<TableCell className="w-[32px] px-2">
														{isExpanded ? (
															<ChevronDownIcon
																strokeWidth={2}
																className="size-4 text-muted-foreground"
															/>
														) : (
															<ChevronRightIcon
																strokeWidth={2}
																className="size-4 text-muted-foreground"
															/>
														)}
													</TableCell>
													<TableCell>
														<span className="font-medium text-primary block">
															{truncateErrorType(errorRow.errorType)}
														</span>
													</TableCell>
													<TableCell>
														<Badge
															variant="secondary"
															className="bg-severity-error/15 text-severity-error"
														>
															{formatNumber(errorRow.count)}
														</Badge>
													</TableCell>
													<TableCell className="hidden md:table-cell text-sm text-muted-foreground">
														{errorRow.affectedServicesCount} service
														{errorRow.affectedServicesCount !== 1 ? "s" : ""}
													</TableCell>
													<TableCell className="hidden md:table-cell text-sm text-muted-foreground">
														{formatTimeAgo(errorRow.lastSeen)}
													</TableCell>
												</TableRow>
												{isExpanded && (
													<TableRow>
														<TableCell colSpan={5} className="p-0">
															<ErrorDetailPanel
																errorRow={errorRow}
																filters={filters}
															/>
														</TableCell>
													</TableRow>
												)}
											</Fragment>
										)
									})
								)}
							</TableBody>
						</Table>
					</div>

					<div className="text-sm text-muted-foreground">
						Showing {errors.length} error type{errors.length !== 1 ? "s" : ""}
					</div>
				</div>
			)
		})
		.render()
}
