import type { ReactNode } from "react"
import {
	Body,
	Button,
	Container,
	Head,
	Hr,
	Html,
	Link,
	Preview,
	Section,
	Tailwind,
	Text,
} from "@react-email/components"

/** Community support channels — shared across onboarding emails. */
const DISCORD_URL = "https://discord.gg/R76jTA4HbJ"
const BOOK_CALL_URL = "https://cal.com/david-granzin/30min"

// -- Tailwind config matching Maple dark theme (shared with weekly-digest) --

const tailwindConfig = {
	theme: {
		extend: {
			colors: {
				maple: {
					bg: "#141210",
					surface: "#1e1b18",
					card: "#262320",
					border: "#3a342e",
					fg: "#e8dfd3",
					"fg-muted": "#8a7f72",
					"fg-dim": "#5c554c",
					orange: "#e8872a",
					green: "#4aa865",
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

interface ShellProps {
	preview: string
	heading: string
	children: ReactNode
	ctaLabel: string
	ctaUrl: string
	footerNote?: string
}

function OnboardingEmailShell({
	preview,
	heading,
	children,
	ctaLabel,
	ctaUrl,
	footerNote,
}: ShellProps) {
	return (
		<Html>
			<Head />
			<Preview>{preview}</Preview>
			<Tailwind config={tailwindConfig}>
				<Body className="m-0 bg-maple-bg px-4 py-10 font-mono">
					<Container className="mx-auto max-w-[520px] overflow-hidden rounded-xl border border-maple-border bg-maple-surface">
						<Section className="px-6 pb-2 pt-6">
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
												color: "#141210",
												fontWeight: 700,
												fontSize: "18px",
											}}
										>
											M
										</td>
									</tr>
								</tbody>
							</table>
						</Section>

						<Section className="px-6 pt-4">
							<Text className="m-0 text-[20px] font-semibold leading-tight text-maple-fg">
								{heading}
							</Text>
						</Section>

						<Section className="px-6 pt-3">{children}</Section>

						<Section className="px-6 pb-2 pt-5">
							<Button
								href={ctaUrl}
								className="rounded-lg bg-maple-orange px-5 py-3 text-[13px] font-semibold text-maple-bg"
							>
								{ctaLabel}
							</Button>
						</Section>

						<Hr className="mx-6 my-5 border-maple-border" />

						<Section className="px-6 pb-6">
							<Text className="m-0 text-[11px] leading-relaxed text-maple-fg-dim">
								{footerNote ??
									"You're receiving this because you started a Maple workspace. Manage email preferences in your account settings."}
							</Text>
						</Section>
					</Container>
				</Body>
			</Tailwind>
		</Html>
	)
}

function Paragraph({ children }: { children: React.ReactNode }) {
	return (
		<Text className="m-0 mb-3 text-[13px] leading-relaxed text-maple-fg-muted">{children}</Text>
	)
}

// -- Templates --

export interface WelcomeEmailProps {
	dashboardUrl: string
	trialDays?: number
}

export function WelcomeEmail({ dashboardUrl, trialDays }: WelcomeEmailProps) {
	return (
		<OnboardingEmailShell
			preview="Welcome to Maple — here's how to see your first trace"
			heading="Welcome to Maple"
			ctaLabel="Open your setup checklist"
			ctaUrl={dashboardUrl}
		>
			<Paragraph>
				Your workspace is ready. Maple gives you traces, logs, and metrics from your
				services in one place — the moment they start sending telemetry.
			</Paragraph>
			<Paragraph>
				{trialDays
					? `Your ${trialDays}-day trial is running. To get value from it, connect an app: open the setup checklist on your dashboard, copy your ingest key, and drop in the snippet for your stack.`
					: "To get started, open the setup checklist on your dashboard, copy your ingest key, and drop in the snippet for your stack."}
			</Paragraph>
			<Paragraph>
				Not ready to instrument code yet? The checklist has a "Send a test event" button
				that confirms your pipeline works in one click.
			</Paragraph>
		</OnboardingEmailShell>
	)
}

export interface ConnectAppEmailProps {
	dashboardUrl: string
}

export function ConnectAppEmail({ dashboardUrl }: ConnectAppEmailProps) {
	return (
		<OnboardingEmailShell
			preview="Connect your app to start getting value from Maple"
			heading="Your workspace is waiting for data"
			ctaLabel="Connect your app"
			ctaUrl={dashboardUrl}
		>
			<Paragraph>
				You set up a Maple workspace, but we haven't seen any telemetry from your services
				yet. Maple only becomes useful once your app is sending traces.
			</Paragraph>
			<Paragraph>
				It takes a few minutes: open the setup checklist, pick your stack, and paste the
				snippet. If you use Claude Code, Codex, or Cursor, the checklist also has a one-line
				prompt that installs OpenTelemetry across your repo automatically.
			</Paragraph>
		</OnboardingEmailShell>
	)
}

export interface StalledEmailProps {
	dashboardUrl: string
}

export function StalledEmail({ dashboardUrl }: StalledEmailProps) {
	return (
		<OnboardingEmailShell
			preview="Stuck connecting your app to Maple? We can help"
			heading="Need a hand connecting your app?"
			ctaLabel="Open the setup checklist"
			ctaUrl={dashboardUrl}
			footerNote="Reply to this email if you'd like help getting set up — a real person will read it."
		>
			<Paragraph>
				It's been a few days and your Maple workspace still hasn't received any telemetry.
				If something got in the way, we'd like to help.
			</Paragraph>
			<Paragraph>
				Common blockers: the ingest key isn't on the exporter, the OTLP endpoint URL is
				missing the signal path, or the service hasn't been redeployed yet. The setup
				checklist has copy-paste snippets for every supported stack.
			</Paragraph>
			<Text className="m-0 mb-2 text-[13px] font-semibold leading-relaxed text-maple-fg">
				Two faster ways to get unstuck:
			</Text>
			<Text className="m-0 mb-2 text-[13px] leading-relaxed text-maple-fg-muted">
				{"· "}
				<Link href={DISCORD_URL} className="text-maple-orange underline">
					Join our Discord
				</Link>
				{" — quick questions get quick answers from the team."}
			</Text>
			<Text className="m-0 mb-3 text-[13px] leading-relaxed text-maple-fg-muted">
				{"· "}
				<Link href={BOOK_CALL_URL} className="text-maple-orange underline">
					Book a 30-minute call
				</Link>
				{" — walk through setup live with David."}
			</Text>
			<Paragraph>
				Want to explore Maple first without wiring up your own app? You can load a demo
				workspace with realistic traces and errors from the dashboard.
			</Paragraph>
		</OnboardingEmailShell>
	)
}

export interface ActivationEmailProps {
	dashboardUrl: string
	serviceName?: string
}

export function ActivationEmail({ dashboardUrl, serviceName }: ActivationEmailProps) {
	return (
		<OnboardingEmailShell
			preview="Your first trace landed in Maple — you're live"
			heading="You're live on Maple"
			ctaLabel="Explore your traces"
			ctaUrl={dashboardUrl}
		>
			<Paragraph>
				{serviceName
					? `We're now seeing telemetry from ${serviceName}. Your workspace is live.`
					: "We're now seeing telemetry from your services. Your workspace is live."}
			</Paragraph>
			<Paragraph>
				Here's what to do next: open a slow trace to see its full span waterfall, check the
				service map to understand how your services call each other, and set up an alert so
				Maple tells you when something breaks.
			</Paragraph>
		</OnboardingEmailShell>
	)
}
