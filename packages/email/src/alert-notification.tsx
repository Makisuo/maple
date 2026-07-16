import { Body, Container, Head, Html, Link, Preview, Section, Tailwind, Text } from "@react-email/components"

/**
 * All values are pre-formatted strings — the api layer formats via the same
 * helpers the Slack/Discord payload builders use, so channels never drift.
 */
export interface AlertNotificationProps {
	ruleName: string
	/** Human event label, e.g. "Triggered" / "Resolved" / "Test". */
	eventLabel: string
	/** Event emoji, e.g. 🚨 / ✅ / 🧪. */
	eventEmoji: string
	severity: string
	signalLabel: string
	/** Group key, or "all". */
	group: string
	/** Observed value + comparison, e.g. "5.2% > 1%". */
	observedSummary: string
	/** Evaluation window, e.g. "5m". */
	window: string
	/** Hex accent color for the event/severity, e.g. "#e01e5a". */
	accentColor: string
	/** Deep link to the alert in Maple. */
	linkUrl: string
	/** Deep link to Maple AI for this alert. */
	chatUrl: string
}

// -- Brand palette (Maple dark theme — mirrors weekly-digest.tsx) --

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
}

const tailwindConfig = {
	theme: {
		extend: {
			colors: {
				maple: {
					bg: C.bg,
					surface: C.surface,
					card: C.card,
					border: C.border,
					"border-subtle": C.borderSubtle,
					fg: C.fg,
					"fg-muted": C.fgMuted,
					"fg-dim": C.fgDim,
					orange: C.orange,
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

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text
}

function DetailRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
	return (
		<tr>
			<td className="w-[110px] border-b border-maple-border-subtle px-3 py-2.5 align-top">
				<Text className="m-0 font-mono text-[10px] uppercase tracking-widest text-maple-fg-dim">
					{label}
				</Text>
			</td>
			<td className="border-b border-maple-border-subtle px-3 py-2.5 align-top">
				<Text
					className="m-0 font-mono text-[13px] leading-snug text-maple-fg"
					style={valueColor ? { color: valueColor } : undefined}
				>
					{value}
				</Text>
			</td>
		</tr>
	)
}

export function AlertNotification(props: AlertNotificationProps) {
	const {
		ruleName,
		eventLabel,
		eventEmoji,
		severity,
		signalLabel,
		group,
		observedSummary,
		window,
		accentColor,
		linkUrl,
		chatUrl,
	} = props

	const previewText = `${eventLabel}: ${ruleName} — ${observedSummary}`

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
												Maple Alerts
											</Text>
											<Text className="m-0 mt-0.5 font-mono text-xs text-maple-fg-muted">
												Alert notification
											</Text>
										</td>
									</tr>
								</tbody>
							</table>
						</Section>

						{/* ── Accent divider ── */}
						<div
							className="mx-6 h-px bg-maple-border"
							style={{
								backgroundImage: `linear-gradient(to right, ${accentColor}, ${C.border} 40%)`,
							}}
						/>

						{/* ── Event banner ── */}
						<Section className="px-5 pt-5">
							<div
								style={{
									borderLeft: `3px solid ${accentColor}`,
									backgroundColor: C.card,
									borderTopRightRadius: "8px",
									borderBottomRightRadius: "8px",
									padding: "14px 16px",
								}}
							>
								<span
									style={{
										display: "inline-block",
										backgroundColor: accentColor,
										color: "#ffffff",
										borderRadius: "5px",
										padding: "3px 8px",
										fontSize: "10px",
										fontWeight: 700,
										letterSpacing: "0.12em",
										textTransform: "uppercase",
									}}
								>
									{eventLabel}
								</span>
								<Text className="m-0 mt-2.5 font-mono text-[15px] font-semibold leading-snug text-maple-fg">
									{eventEmoji} {truncate(ruleName, 80)}
								</Text>
								<Text className="m-0 mt-1 font-mono text-[12px] leading-snug text-maple-fg-muted">
									{observedSummary}
								</Text>
							</div>
						</Section>

						{/* ── Details ── */}
						<Section className="px-6 pt-5">
							<div className="overflow-hidden rounded-lg border border-maple-border-subtle bg-maple-card">
								<table className="w-full border-collapse">
									<tbody>
										<DetailRow
											label="Severity"
											value={severity}
											valueColor={accentColor}
										/>
										<DetailRow label="Signal" value={signalLabel} />
										<DetailRow label="Group" value={group} />
										<DetailRow label="Observed" value={observedSummary} />
										<DetailRow label="Window" value={window} />
									</tbody>
								</table>
							</div>
						</Section>

						{/* ── CTAs ── */}
						<Section className="px-6 pb-2 pt-6">
							<table className="w-full border-collapse">
								<tbody>
									<tr>
										<td className="w-1/2 pr-1">
											<Link
												href={linkUrl}
												className="block rounded-lg bg-maple-orange px-4 py-3 text-center font-mono text-sm font-semibold text-white no-underline"
											>
												Open in Maple &rarr;
											</Link>
										</td>
										<td className="w-1/2 pl-1">
											<Link
												href={chatUrl}
												className="block rounded-lg border border-solid border-maple-border bg-maple-card px-4 py-3 text-center font-mono text-sm font-semibold text-maple-fg no-underline"
											>
												Ask Maple AI
											</Link>
										</td>
									</tr>
								</tbody>
							</table>
						</Section>

						{/* ── Footer ── */}
						<Section className="px-6 pb-6 pt-3">
							<Text className="m-0 text-center font-mono text-[11px] text-maple-fg-dim">
								&#127809; Maple Alerts &middot; You are receiving this because this address is
								an alert destination for your organization.
							</Text>
						</Section>
					</Container>
				</Body>
			</Tailwind>
		</Html>
	)
}
