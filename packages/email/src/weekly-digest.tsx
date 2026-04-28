import {
	Body,
	Column,
	Container,
	Head,
	Hr,
	Html,
	Link,
	Preview,
	Row,
	Section,
	Tailwind,
	Text,
} from "@react-email/components"

export interface WeeklyDigestProps {
	orgName: string
	dateRange: { start: string; end: string }
	summary: {
		requests: { value: number; delta: number }
		errors: { value: number; delta: number }
		p95Latency: { valueMs: number; delta: number }
		dataVolume: { valueBytes: number; delta: number }
	}
	services: Array<{
		name: string
		requests: number
		errorRate: number
		p95Ms: number
	}>
	topErrors: Array<{ message: string; count: number }>
	ingestion: {
		logs: number
		traces: number
		metrics: number
		totalBytes: number
	}
	dashboardUrl: string
	unsubscribeUrl: string
}

// -- Formatters (self-contained, no external deps) --

function fmtNum(num: number): string {
	if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`
	if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`
	return num.toLocaleString("en-US")
}

function fmtBytes(bytes: number): string {
	if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
	if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
	if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`
	return `${bytes} B`
}

function fmtLatency(ms: number): string {
	if (ms < 1) return `${(ms * 1000).toFixed(0)}us`
	if (ms < 1000) return `${ms.toFixed(1)}ms`
	return `${(ms / 1000).toFixed(2)}s`
}

function fmtErrRate(rate: number): string {
	if (rate < 0.01) return "0%"
	if (rate < 1) return `${rate.toFixed(2)}%`
	return `${rate.toFixed(1)}%`
}

function fmtDelta(delta: number): string {
	const sign = delta >= 0 ? "+" : ""
	return `${sign}${delta.toFixed(1)}%`
}

// -- Tailwind config matching Maple dark theme (OKLCH → hex) --

const tailwindConfig = {
	theme: {
		extend: {
			colors: {
				maple: {
					bg: "#141210",
					surface: "#1e1b18",
					card: "#262320",
					elevated: "#2e2a26",
					border: "#3a342e",
					"border-subtle": "#302b26",
					fg: "#e8dfd3",
					"fg-muted": "#8a7f72",
					"fg-dim": "#5c554c",
					orange: "#e8872a",
					"orange-light": "#f0a050",
					"orange-dim": "#a05e1c",
					green: "#4aa865",
					"green-dim": "#2d6b3d",
					red: "#e85d4a",
					"red-dim": "#8b3530",
					blue: "#4a9eff",
					amber: "#e8a02a",
				},
			},
			fontFamily: {
				mono: [
					"'SFMono-Regular'",
					"'SF Mono'",
					"Menlo",
					"Consolas",
					"'Liberation Mono'",
					"monospace",
				],
			},
		},
	},
}

// -- Sub-components --

function DeltaBadge({ delta, invertColor = false }: { delta: number; invertColor?: boolean }) {
	const isPositive = delta >= 0
	const isGood = invertColor ? !isPositive : isPositive
	const color = delta === 0 ? "text-maple-fg-dim" : isGood ? "text-maple-green" : "text-maple-red"
	const arrow = delta === 0 ? "" : delta > 0 ? "\u2191" : "\u2193"

	return (
		<Text className={`m-0 mt-1 font-mono text-xs leading-tight ${color}`}>
			{arrow} {fmtDelta(delta)}
		</Text>
	)
}

function SummaryCard({
	label,
	value,
	delta,
	invertColor = false,
}: {
	label: string
	value: string
	delta: number
	invertColor?: boolean
}) {
	return (
		<td className="w-1/2 p-1">
			<div className="rounded-lg bg-maple-card px-4 py-3.5">
				<Text className="m-0 mb-1.5 font-mono text-[10px] uppercase tracking-widest text-maple-fg-dim">
					{label}
				</Text>
				<Text className="m-0 font-mono text-[22px] font-semibold leading-none text-maple-fg">
					{value}
				</Text>
				<DeltaBadge delta={delta} invertColor={invertColor} />
			</div>
		</td>
	)
}

function errRateColor(rate: number): string {
	if (rate >= 5) return "text-maple-red"
	if (rate >= 1) return "text-maple-amber"
	return "text-maple-fg-muted"
}

// -- Main template --

export function WeeklyDigest({
	orgName,
	dateRange,
	summary,
	services,
	topErrors,
	ingestion,
	dashboardUrl,
	unsubscribeUrl,
}: WeeklyDigestProps) {
	const previewText = `${fmtNum(summary.requests.value)} reqs, ${fmtNum(summary.errors.value)} errors — ${orgName} weekly digest`

	return (
		<Html>
			<Head />
			<Preview>{previewText}</Preview>
			<Tailwind config={tailwindConfig}>
				<Body className="m-0 bg-maple-bg px-4 py-10 font-mono">
					<Container className="mx-auto max-w-[560px] overflow-hidden rounded-xl border border-maple-border bg-maple-surface">
						{/* ── Header ── */}
						<Section className="px-6 pb-5 pt-6">
							<table className="w-full">
								<tbody>
									<tr>
										<td className="w-[36px] pr-3 align-middle">
											{/* Maple "M" logo mark — table cell for email compat */}
											<table cellPadding={0} cellSpacing={0} role="presentation">
												<tbody>
													<tr>
														<td
															style={{
																width: "32px",
																height: "32px",
																backgroundColor: "#e8872a",
																borderRadius: "8px",
																textAlign: "center",
																verticalAlign: "middle",
																fontFamily:
																	"system-ui, -apple-system, sans-serif",
																fontSize: "18px",
																fontWeight: 700,
																color: "#ffffff",
																lineHeight: "32px",
															}}
														>
															M
														</td>
													</tr>
												</tbody>
											</table>
										</td>
										<td className="align-middle">
											<Text className="m-0 font-mono text-base font-semibold text-maple-fg">
												Weekly Digest
											</Text>
											<Text className="m-0 mt-0.5 font-mono text-xs text-maple-fg-muted">
												{orgName} &middot; {dateRange.start} &ndash; {dateRange.end}
											</Text>
										</td>
									</tr>
								</tbody>
							</table>
						</Section>

						{/* ── Orange accent divider ── */}
						<div
							className="mx-6 h-px bg-maple-border"
							style={{ backgroundImage: "linear-gradient(to right, #e8872a, #3a342e 40%)" }}
						/>

						{/* ── Summary Cards 2x2 ── */}
						<Section className="px-5 pt-5">
							<table className="w-full border-collapse">
								<tbody>
									<tr>
										<SummaryCard
											label="Requests"
											value={fmtNum(summary.requests.value)}
											delta={summary.requests.delta}
										/>
										<SummaryCard
											label="Errors"
											value={fmtNum(summary.errors.value)}
											delta={summary.errors.delta}
											invertColor
										/>
									</tr>
									<tr>
										<SummaryCard
											label="P95 Latency"
											value={fmtLatency(summary.p95Latency.valueMs)}
											delta={summary.p95Latency.delta}
											invertColor
										/>
										<SummaryCard
											label="Data Volume"
											value={fmtBytes(summary.dataVolume.valueBytes)}
											delta={summary.dataVolume.delta}
										/>
									</tr>
								</tbody>
							</table>
						</Section>

						{/* ── Service Health ── */}
						<Section className="px-6 pt-5">
							<Text className="m-0 mb-3 font-mono text-[10px] uppercase tracking-widest text-maple-fg-dim">
								Service Health
							</Text>
							<div className="overflow-hidden rounded-lg border border-maple-border-subtle bg-maple-card">
								<table className="w-full border-collapse">
									<thead>
										<tr>
											<th className="border-b border-maple-border-subtle px-3 py-2 text-left font-mono text-[10px] font-medium uppercase tracking-widest text-maple-fg-dim">
												Service
											</th>
											<th className="border-b border-maple-border-subtle px-3 py-2 text-right font-mono text-[10px] font-medium uppercase tracking-widest text-maple-fg-dim">
												Reqs
											</th>
											<th className="border-b border-maple-border-subtle px-3 py-2 text-right font-mono text-[10px] font-medium uppercase tracking-widest text-maple-fg-dim">
												Err%
											</th>
											<th className="border-b border-maple-border-subtle px-3 py-2 text-right font-mono text-[10px] font-medium uppercase tracking-widest text-maple-fg-dim">
												P95
											</th>
										</tr>
									</thead>
									<tbody>
										{services.map((service, idx) => (
											<tr key={service.name}>
												<td
													className={`px-3 py-2.5 ${idx < services.length - 1 ? "border-b border-maple-border-subtle" : ""}`}
												>
													<Text className="m-0 font-mono text-[13px] font-medium text-maple-fg">
														{service.name}
													</Text>
												</td>
												<td
													className={`px-3 py-2.5 text-right ${idx < services.length - 1 ? "border-b border-maple-border-subtle" : ""}`}
												>
													<Text className="m-0 font-mono text-[13px] text-maple-fg-muted">
														{fmtNum(service.requests)}
													</Text>
												</td>
												<td
													className={`px-3 py-2.5 text-right ${idx < services.length - 1 ? "border-b border-maple-border-subtle" : ""}`}
												>
													<Text
														className={`m-0 font-mono text-[13px] ${errRateColor(service.errorRate)}`}
													>
														{fmtErrRate(service.errorRate)}
													</Text>
												</td>
												<td
													className={`px-3 py-2.5 text-right ${idx < services.length - 1 ? "border-b border-maple-border-subtle" : ""}`}
												>
													<Text className="m-0 font-mono text-[13px] text-maple-fg-muted">
														{fmtLatency(service.p95Ms)}
													</Text>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</Section>

						{/* ── Top Errors ── */}
						{topErrors.length > 0 && (
							<Section className="px-6 pt-5">
								<Text className="m-0 mb-3 font-mono text-[10px] uppercase tracking-widest text-maple-fg-dim">
									Top Errors
								</Text>
								<div className="overflow-hidden rounded-lg border border-maple-border-subtle bg-maple-card">
									{topErrors.map((error, i) => (
										<div
											key={i}
											className={`px-3 py-2.5 ${i < topErrors.length - 1 ? "border-b border-maple-border-subtle" : ""}`}
										>
											<table className="w-full">
												<tbody>
													<tr>
														<td className="w-[20px] align-top">
															<Text className="m-0 font-mono text-[13px] text-maple-fg-dim">
																{i + 1}.
															</Text>
														</td>
														<td className="align-top">
															<Text className="m-0 font-mono text-[13px] leading-snug text-maple-fg">
																{error.message.length > 72
																	? `${error.message.slice(0, 72)}...`
																	: error.message}
															</Text>
														</td>
														<td className="w-[60px] text-right align-top">
															<Text className="m-0 font-mono text-[13px] font-medium text-maple-red">
																{fmtNum(error.count)}&times;
															</Text>
														</td>
													</tr>
												</tbody>
											</table>
										</div>
									))}
								</div>
							</Section>
						)}

						{/* ── Ingestion ── */}
						<Section className="px-6 pt-5">
							<Text className="m-0 mb-3 font-mono text-[10px] uppercase tracking-widest text-maple-fg-dim">
								Ingestion
							</Text>
							<table className="w-full border-collapse">
								<tbody>
									<tr>
										{(
											[
												["Logs", fmtNum(ingestion.logs)],
												["Traces", fmtNum(ingestion.traces)],
												["Metrics", fmtNum(ingestion.metrics)],
												["Total", fmtBytes(ingestion.totalBytes)],
											] as const
										).map(([label, val]) => (
											<td key={label} className="w-1/4 p-1">
												<div className="rounded-lg bg-maple-card px-3 py-2.5 text-center">
													<Text className="m-0 mb-1 font-mono text-[10px] uppercase tracking-widest text-maple-fg-dim">
														{label}
													</Text>
													<Text className="m-0 font-mono text-sm font-semibold text-maple-fg">
														{val}
													</Text>
												</div>
											</td>
										))}
									</tr>
								</tbody>
							</table>
						</Section>

						{/* ── CTA ── */}
						<Section className="px-6 pt-6 pb-2">
							<Link
								href={dashboardUrl}
								className="block rounded-lg bg-maple-orange px-6 py-3 text-center font-mono text-sm font-semibold text-white no-underline"
							>
								View Dashboard &rarr;
							</Link>
						</Section>

						{/* ── Footer ── */}
						<Section className="px-6 pb-6 pt-3">
							<Text className="m-0 text-center font-mono text-[11px] text-maple-fg-dim">
								You subscribed to weekly digests.{" "}
								<Link href={unsubscribeUrl} className="text-maple-fg-muted underline">
									Unsubscribe
								</Link>
							</Text>
						</Section>
					</Container>
				</Body>
			</Tailwind>
		</Html>
	)
}

export default WeeklyDigest
