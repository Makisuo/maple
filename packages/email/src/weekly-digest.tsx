import { Body, Container, Head, Html, Link, Preview, Section, Tailwind, Text } from "@react-email/components"
import {
	deltaArrow,
	deriveDigestStatus,
	fmtBytes,
	fmtDeltaAbs,
	fmtErrRate,
	fmtLatency,
	fmtNum,
	type DigestSeriesPoint,
	type DigestStatus,
	type DigestStatusLevel,
	type WeeklyDigestProps,
} from "./weekly-digest-core"

// Re-export the react-free core so existing importers keep working. New code
// that only needs types/derivation should import "./weekly-digest-core"
// directly and leave this module (and @react-email) to be loaded lazily.
export {
	deriveDigestStatus,
	type DigestSeriesPoint,
	type DigestService,
	type DigestStatus,
	type DigestStatusLevel,
	type DigestTopError,
	type WeeklyDigestProps,
} from "./weekly-digest-core"

// -- Brand palette (Maple dark theme, OKLCH → hex) --

const C = {
	bg: "#141210",
	surface: "#1e1b18",
	card: "#262320",
	border: "#3a342e",
	borderSubtle: "#302b26",
	fg: "#e8dfd3",
	fgMuted: "#8a7f72",
	fgDim: "#5c554c",
	orange: "#e8872a",
	green: "#4aa865",
	red: "#e85d4a",
	amber: "#e8a02a",
}

// -- Tailwind config matching Maple dark theme --

const tailwindConfig = {
	theme: {
		extend: {
			colors: {
				maple: {
					bg: C.bg,
					surface: C.surface,
					card: C.card,
					elevated: "#2e2a26",
					border: C.border,
					"border-subtle": C.borderSubtle,
					fg: C.fg,
					"fg-muted": C.fgMuted,
					"fg-dim": C.fgDim,
					orange: C.orange,
					"orange-light": "#f0a050",
					"orange-dim": "#a05e1c",
					green: C.green,
					"green-dim": "#2d6b3d",
					red: C.red,
					"red-dim": "#8b3530",
					blue: "#4a9eff",
					amber: C.amber,
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

const STATUS_THEME: Record<
	DigestStatusLevel,
	{ accent: string; bg: string; pillBg: string; pillFg: string }
> = {
	healthy: { accent: C.green, bg: "rgba(74,168,101,0.09)", pillBg: "#2d6b3d", pillFg: "#d6f0de" },
	watch: { accent: C.amber, bg: "rgba(232,160,42,0.09)", pillBg: "#7a5410", pillFg: "#f7e6c4" },
	critical: { accent: C.red, bg: "rgba(232,93,74,0.10)", pillBg: "#8b3530", pillFg: "#f8d8d2" },
}

// -- Sub-components --

function DeltaPill({ delta, invertColor = false }: { delta: number; invertColor?: boolean }) {
	if (!Number.isFinite(delta)) return null
	const neutral = Math.abs(delta) < 0.05
	const isPositive = delta >= 0
	const isGood = invertColor ? !isPositive : isPositive
	const palette = neutral
		? { color: C.fgMuted, bg: "rgba(138,127,114,0.14)" }
		: isGood
			? { color: C.green, bg: "rgba(74,168,101,0.15)" }
			: { color: C.red, bg: "rgba(232,93,74,0.15)" }

	return (
		<span
			style={{
				display: "inline-block",
				backgroundColor: palette.bg,
				color: palette.color,
				borderRadius: "5px",
				padding: "2px 6px",
				fontSize: "11px",
				fontWeight: 600,
				lineHeight: "14px",
			}}
		>
			{deltaArrow(delta)} {fmtDeltaAbs(delta)}
		</span>
	)
}

function StatusBanner({ status }: { status: DigestStatus }) {
	const theme = STATUS_THEME[status.level]
	return (
		<Section className="px-5 pt-5">
			<div
				style={{
					borderLeft: `3px solid ${theme.accent}`,
					backgroundColor: theme.bg,
					borderTopRightRadius: "8px",
					borderBottomRightRadius: "8px",
					padding: "14px 16px",
				}}
			>
				<span
					style={{
						display: "inline-block",
						backgroundColor: theme.pillBg,
						color: theme.pillFg,
						borderRadius: "5px",
						padding: "3px 8px",
						fontSize: "10px",
						fontWeight: 700,
						letterSpacing: "0.12em",
					}}
				>
					{status.label}
				</span>
				<Text className="m-0 mt-2.5 font-mono text-[14px] font-medium leading-snug text-maple-fg">
					{status.headline}
				</Text>
				{status.biggestMover && (
					<Text className="m-0 mt-1 font-mono text-[12px] leading-snug text-maple-fg-muted">
						{status.biggestMover}
					</Text>
				)}
			</div>
		</Section>
	)
}

function TrendSparkline({
	series,
	totalRequests,
	requestsDelta,
}: {
	series: Array<DigestSeriesPoint>
	totalRequests: number
	requestsDelta: number
}) {
	if (series.length === 0) return null
	const MAX_BAR = 52
	const maxReq = Math.max(1, ...series.map((d) => d.requests))

	return (
		<Section className="px-6 pt-5">
			<table className="w-full">
				<tbody>
					<tr>
						<td className="align-middle">
							<Text className="m-0 font-mono text-[10px] uppercase tracking-widest text-maple-fg-dim">
								Requests &middot; 7-day trend
							</Text>
						</td>
						<td className="text-right align-middle">
							<Text className="m-0 font-mono text-[13px] font-semibold text-maple-fg">
								{fmtNum(totalRequests)}{" "}
								<span style={{ fontWeight: 400 }}>
									<DeltaPill delta={requestsDelta} />
								</span>
							</Text>
						</td>
					</tr>
				</tbody>
			</table>
			<div className="mt-2 rounded-lg border border-maple-border-subtle bg-maple-card px-3 pb-2 pt-3">
				<table className="w-full" style={{ borderCollapse: "collapse" }}>
					<tbody>
						<tr>
							{series.map((d, i) => {
								const reqH =
									d.requests > 0
										? Math.max(2, Math.round((d.requests / maxReq) * MAX_BAR))
										: 0
								let errH = d.requests > 0 ? Math.round((d.errors / d.requests) * reqH) : 0
								if (d.errors > 0) errH = Math.max(2, errH)
								errH = Math.min(errH, reqH)
								const okH = Math.max(0, reqH - errH)
								return (
									<td
										key={i}
										style={{
											height: `${MAX_BAR}px`,
											verticalAlign: "bottom",
											padding: "0 3px",
										}}
									>
										{okH > 0 && (
											<div
												style={{
													height: `${okH}px`,
													backgroundColor: C.orange,
													borderTopLeftRadius: "3px",
													borderTopRightRadius: "3px",
													borderBottomLeftRadius: errH > 0 ? "0" : "3px",
													borderBottomRightRadius: errH > 0 ? "0" : "3px",
												}}
											/>
										)}
										{errH > 0 && (
											<div
												style={{
													height: `${errH}px`,
													backgroundColor: C.red,
													borderTopLeftRadius: okH > 0 ? "0" : "3px",
													borderTopRightRadius: okH > 0 ? "0" : "3px",
													borderBottomLeftRadius: "3px",
													borderBottomRightRadius: "3px",
												}}
											/>
										)}
									</td>
								)
							})}
						</tr>
						<tr>
							{series.map((d, i) => (
								<td key={i} style={{ textAlign: "center", paddingTop: "6px" }}>
									<Text className="m-0 font-mono text-[9px] text-maple-fg-dim">
										{d.label}
									</Text>
								</td>
							))}
						</tr>
					</tbody>
				</table>
			</div>
		</Section>
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
				<Text className="m-0 mb-2 font-mono text-[22px] font-semibold leading-none text-maple-fg">
					{value}
				</Text>
				<DeltaPill delta={delta} invertColor={invertColor} />
			</div>
		</td>
	)
}

function errRateColor(rate: number): string {
	if (rate >= 5) return "text-maple-red"
	if (rate >= 1) return "text-maple-amber"
	return "text-maple-fg-muted"
}

function statusDotColor(rate: number): string {
	if (rate >= 5) return C.red
	if (rate >= 1) return C.amber
	return C.green
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text
}

// -- Main template --

export function WeeklyDigest(props: WeeklyDigestProps) {
	const {
		orgName,
		dateRange,
		summary,
		series,
		services,
		topErrors,
		ingestion,
		baseUrl,
		dashboardUrl,
		unsubscribeUrl,
	} = props

	const status = deriveDigestStatus(props)
	const previewText = `${status.label === "HEALTHY" ? "" : `${status.label} · `}${fmtNum(summary.requests.value)} reqs, ${fmtNum(summary.errors.value)} errors — ${orgName} weekly digest`
	const errorsUrl = `${baseUrl}/errors?timePreset=7d`
	const serviceUrl = (name: string) => `${baseUrl}/services/${encodeURIComponent(name)}?timePreset=7d`

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
																backgroundColor: C.orange,
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
												{truncate(orgName, 32)}
											</Text>
											<Text className="m-0 mt-0.5 font-mono text-xs text-maple-fg-muted">
												Weekly digest &middot; {dateRange.start} &ndash;{" "}
												{dateRange.end}
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

						{/* ── Health verdict banner ── */}
						<StatusBanner status={status} />

						{/* ── 7-day trend sparkline ── */}
						<TrendSparkline
							series={series}
							totalRequests={summary.requests.value}
							requestsDelta={summary.requests.delta}
						/>

						{/* ── Summary Cards 2x2 ── */}
						<Section className="px-5 pt-4">
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
						{services.length > 0 && (
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
											{services.map((service, idx) => {
												const border =
													idx < services.length - 1
														? "border-b border-maple-border-subtle"
														: ""
												return (
													<tr key={service.name}>
														<td className={`px-3 py-2.5 ${border}`}>
															<Link
																href={serviceUrl(service.name)}
																className="font-mono text-[13px] font-medium text-maple-fg no-underline"
															>
																<span
																	style={{
																		color: statusDotColor(
																			service.errorRate,
																		),
																		fontSize: "9px",
																		marginRight: "6px",
																	}}
																>
																	&#9679;
																</span>
																{truncate(service.name, 24)}
															</Link>
														</td>
														<td
															className={`px-3 py-2.5 text-right align-middle ${border}`}
														>
															<Text className="m-0 font-mono text-[13px] text-maple-fg-muted">
																{fmtNum(service.requests)}
															</Text>
															{service.requestsDelta != null &&
																Number.isFinite(service.requestsDelta) && (
																	<Text
																		className="m-0 font-mono text-[10px] leading-tight"
																		style={{
																			color:
																				Math.abs(
																					service.requestsDelta,
																				) < 0.05
																					? C.fgDim
																					: service.requestsDelta >
																						  0
																						? C.green
																						: C.red,
																		}}
																	>
																		{deltaArrow(service.requestsDelta)}{" "}
																		{fmtDeltaAbs(service.requestsDelta)}
																	</Text>
																)}
														</td>
														<td
															className={`px-3 py-2.5 text-right align-middle ${border}`}
														>
															<Text
																className={`m-0 font-mono text-[13px] ${errRateColor(service.errorRate)}`}
															>
																{fmtErrRate(service.errorRate)}
															</Text>
														</td>
														<td
															className={`px-3 py-2.5 text-right align-middle ${border}`}
														>
															<Text className="m-0 font-mono text-[13px] text-maple-fg-muted">
																{fmtLatency(service.p95Ms)}
															</Text>
														</td>
													</tr>
												)
											})}
										</tbody>
									</table>
								</div>
							</Section>
						)}

						{/* ── Top Errors ── */}
						{topErrors.length > 0 && (
							<Section className="px-6 pt-5">
								<table className="w-full">
									<tbody>
										<tr>
											<td className="align-middle">
												<Text className="m-0 font-mono text-[10px] uppercase tracking-widest text-maple-fg-dim">
													Top Errors
												</Text>
											</td>
											<td className="text-right align-middle">
												<Link
													href={errorsUrl}
													className="font-mono text-[10px] uppercase tracking-widest text-maple-orange no-underline"
												>
													View all &rarr;
												</Link>
											</td>
										</tr>
									</tbody>
								</table>
								<div className="mt-2 overflow-hidden rounded-lg border border-maple-border-subtle bg-maple-card">
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
																{error.isNew && (
																	<span
																		style={{
																			display: "inline-block",
																			backgroundColor:
																				"rgba(232,93,74,0.16)",
																			color: C.red,
																			borderRadius: "4px",
																			padding: "1px 5px",
																			fontSize: "9px",
																			fontWeight: 700,
																			letterSpacing: "0.08em",
																			marginRight: "6px",
																			verticalAlign: "middle",
																		}}
																	>
																		NEW
																	</span>
																)}
																{truncate(error.message, 64)}
															</Text>
															{error.affectedServices != null &&
																error.affectedServices > 0 && (
																	<Text className="m-0 mt-0.5 font-mono text-[10px] leading-tight text-maple-fg-dim">
																		{error.affectedServices} service
																		{error.affectedServices === 1
																			? ""
																			: "s"}{" "}
																		affected
																	</Text>
																)}
														</td>
														<td className="w-[56px] text-right align-top">
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
												["Logs", fmtNum(ingestion.logs), null],
												["Traces", fmtNum(ingestion.traces), null],
												["Metrics", fmtNum(ingestion.metrics), null],
												[
													"Total",
													fmtBytes(ingestion.totalBytes),
													summary.dataVolume.delta,
												],
											] as const
										).map(([label, val, delta]) => (
											<td key={label} className="w-1/4 p-1">
												<div className="rounded-lg bg-maple-card px-3 py-2.5 text-center">
													<Text className="m-0 mb-1 font-mono text-[10px] uppercase tracking-widest text-maple-fg-dim">
														{label}
													</Text>
													<Text className="m-0 font-mono text-sm font-semibold text-maple-fg">
														{val}
													</Text>
													{delta != null && Number.isFinite(delta) && (
														<Text
															className="m-0 mt-1 font-mono text-[10px] leading-tight"
															style={{
																color:
																	Math.abs(delta) < 0.05
																		? C.fgDim
																		: delta > 0
																			? C.green
																			: C.red,
															}}
														>
															{deltaArrow(delta)} {fmtDeltaAbs(delta)}
														</Text>
													)}
												</div>
											</td>
										))}
									</tr>
								</tbody>
							</table>
						</Section>

						{/* ── CTA ── */}
						<Section className="px-6 pb-2 pt-6">
							<Link
								href={dashboardUrl}
								className="block rounded-lg bg-maple-orange px-6 py-3 text-center font-mono text-sm font-semibold text-white no-underline"
							>
								Open dashboard &rarr;
							</Link>
						</Section>

						{/* ── Footer ── */}
						<Section className="px-6 pb-6 pt-3">
							<Text className="m-0 text-center font-mono text-[11px] text-maple-fg-dim">
								Powered by{" "}
								<Link href={baseUrl} className="text-maple-fg-muted no-underline">
									Maple
								</Link>{" "}
								&middot; You subscribed to weekly digests.{" "}
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
