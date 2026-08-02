import type { AlertDestinationType } from "@maple/domain/http"
import { useState, type ReactNode } from "react"
import { CodeIcon, DiscordIcon, EnvelopeIcon, HazelIcon, SlackIcon } from "@/components/icons"
import { SLACK_ACCENT, SLACK_ACCENT_ON_LIGHT } from "@/components/integrations/integration-catalog"
import { cn } from "@maple/ui/utils"

const BRANDFETCH_CLIENT_ID = "1id0IQ-4i8Z46-n-DfQ"

// Both Slack rows are the same brand: derive every Slack color from the one
// accent the integrations catalog owns — already theme-aware (deep aubergine on
// light, the same hue lifted on dark, where the aubergine is darker than the card
// and disappears). That keeps the selected tile ring in the picker visible.
const SLACK_ACCENT_BG = `color-mix(in srgb, ${SLACK_ACCENT} 30%, transparent)`
// Slack's pale lilac only reads on dark (8.0:1 on the 30% tint); the aubergine
// holds AA on light (7.5:1).
const SLACK_ACCENT_TEXT = `light-dark(${SLACK_ACCENT_ON_LIGHT}, #E8C5EA)`

// Both Hazel rows are the same brand. Its orange is 2.5:1 on its own light tint —
// burnt orange for light, brand orange on dark (4.6:1).
const HAZEL_ACCENT_TEXT = "light-dark(#A34209, #F46F0F)"

/**
 * The two label inks a brand-accent-filled surface can carry. Both are canvas
 * constants, not theme tokens: the fill is an opaque brand color that does not
 * change with the theme, so the ink must not either (`--card-foreground` would
 * invert underneath a fill that stayed put).
 *
 * They are the app's own two card surfaces, reused as ink — white is light
 * `--card` (`oklch(1 0 0)`) and #1E1B17 is dark `--card` (`oklch(0.224 0.009 75)`).
 */
const INK_ON_DARK_ACCENT = "#FFFFFF"
const INK_ON_BRIGHT_ACCENT = "#1E1B17"

function brandfetchUrl(domain: string, size = 64): string {
	return `https://cdn.brandfetch.io/${domain}/w/${size}/h/${size}/theme/dark/icon.jpeg?c=${BRANDFETCH_CLIENT_ID}`
}

export type DestinationProvider = {
	type: AlertDestinationType
	label: string
	description: string
	/** brand accent in HSL-compatible CSS color */
	accent: string
	/** subtle background tint for the logo tile */
	accentBg: string
	/**
	 * Label ink for anything painted *on top of* `accent` as an opaque fill — the
	 * save button, the monogram plate. Required, not defaulted: half these brands
	 * are bright enough that white is unreadable on them (webhook's amber puts
	 * white at 2.15:1), so a silent `#fff` default would keep shipping the bug
	 * every time a destination type is added. Pick `INK_ON_DARK_ACCENT` or
	 * `INK_ON_BRIGHT_ACCENT` and record the measured ratio.
	 *
	 * Button labels are 14px medium — normal text, so the bar is AA 4.5:1 against
	 * `accent` itself (an opaque fill; nothing composites through it). When
	 * `accent` is a `light-dark()` pair, both halves owe the ratio.
	 */
	accentOn: string
	/**
	 * Readable brand color for text/borders — falls back to `accent` if omitted.
	 * Use a `light-dark()` value when the brand color only reads on one theme;
	 * consumers must combine it with `color-mix()` (not hex-alpha concatenation).
	 *
	 * This is label text at 10px, so it owes AA 4.5:1 against `accentBg` composited
	 * over `--card` — on *both* canvases. Saturated brand hues clear that on the
	 * dark card and fail on their own light tint (a 16% wash over white is ~0.89
	 * luminance), which is why most entries below darken only the light half.
	 */
	accentText?: string
	brandfetchDomain?: string
	/** Letter plate shown when there's no mark (or the CDN logo 404s). The letter is
	 *  drawn in `accentOn`, so a custom gradient has to stay in `accent`'s luminance
	 *  range — the default gradient is `accent` on both stops. */
	monogram?: { letter: string; gradient: [string, string] }
	fallbackIcon?: (props: { size?: number; className?: string }) => ReactNode
	docsUrl?: string
	docsLabel?: string
}

export const PROVIDERS: Record<AlertDestinationType, DestinationProvider> = {
	"slack-bot": {
		type: "slack-bot",
		label: "Slack (bot)",
		description: "Post alerts to a channel via the installed Maple Slack app — no webhook to manage.",
		accent: SLACK_ACCENT,
		accentBg: SLACK_ACCENT_BG,
		accentText: SLACK_ACCENT_TEXT,
		// 14.0:1 light / 4.65:1 dark.
		accentOn: INK_ON_DARK_ACCENT,
		fallbackIcon: ({ size = 22, className }) => <SlackIcon size={size} className={className} />,
		docsUrl: "https://maple.dev/docs/integrations/slack",
		docsLabel: "Slack integration guide",
	},
	pagerduty: {
		type: "pagerduty",
		label: "PagerDuty",
		description: "Trigger incidents with a PagerDuty Events API v2 integration key.",
		accent: "#06AC38",
		accentBg: "rgba(6,172,56,0.16)",
		// Brand green is 2.5:1 on its own light tint — darken for light, keep the
		// brand hue on dark (4.6:1). The logo tile still renders the true green.
		accentText: "light-dark(#056B2A, #06AC38)",
		// White on the brand green is 3.01:1 — a mid-luminance green carries dark
		// ink, not light. #1E1B17 on #06AC38 is 5.69:1.
		accentOn: INK_ON_BRIGHT_ACCENT,
		brandfetchDomain: "pagerduty.com",
		docsUrl: "https://maple.dev/docs/alerting/notification-destinations#pagerduty",
		docsLabel: "PagerDuty setup guide",
	},
	webhook: {
		type: "webhook",
		label: "Webhook",
		description: "POST a signed JSON payload to any HTTP endpoint you control.",
		accent: "#F59E0B",
		accentBg: "rgba(245,158,11,0.16)",
		// Amber on its own light tint is 1.9:1 — deepen it for light, keep amber on dark.
		accentText: "light-dark(#8F5A00, #F59E0B)",
		// The brightest accent in the set: white lands at 2.15:1, the worst of the
		// eight. #1E1B17 on the amber is 7.99:1.
		accentOn: INK_ON_BRIGHT_ACCENT,
		fallbackIcon: ({ size = 22, className }) => <CodeIcon size={size} className={className} />,
	},
	"hazel-oauth": {
		type: "hazel-oauth",
		label: "Hazel",
		description: "Connect Hazel via OAuth and pick a workspace to route alerts into.",
		accent: "#F46F0F",
		accentBg: "rgba(244,111,15,0.16)",
		accentText: HAZEL_ACCENT_TEXT,
		// 2.95:1 white, 5.82:1 on #1E1B17.
		accentOn: INK_ON_BRIGHT_ACCENT,
		fallbackIcon: ({ size = 22, className }) => <HazelIcon size={size} className={className} />,
		docsUrl: "https://hazel.sh/docs/integrations/maple",
		docsLabel: "Hazel integration guide",
	},
	discord: {
		type: "discord",
		label: "Discord",
		description: "Post alerts to a Discord channel via incoming webhook.",
		accent: "#5865F2",
		accentBg: "rgba(88,101,242,0.18)",
		// The pale blurple is 1.2:1 on the light tint (#E1E3FD) — invisible label and
		// border. Discord's darker rebrand blurple takes light (4.7:1); the pale one
		// still owns dark (9.3:1).
		accentText: "light-dark(#404EED, #C7CDFF)",
		// Blurple is the one saturated accent dark enough for white: 4.61:1. Dark ink
		// would be worse (4.06:1), so this stays light — but it has no headroom, and
		// a lighter blurple would have to move the ink with it.
		accentOn: INK_ON_DARK_ACCENT,
		fallbackIcon: ({ size = 22, className }) => <DiscordIcon size={size} className={className} />,
		docsUrl: "https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks",
		docsLabel: "Discord webhook docs",
	},
	email: {
		type: "email",
		label: "Email",
		description: "Send alert notifications to one or more email addresses.",
		accent: "#E8872A",
		accentBg: "rgba(232,135,42,0.16)",
		// 2.3:1 on its own light tint — deepen for light, keep the accent on dark.
		accentText: "light-dark(#9A4E10, #E8872A)",
		// White on the warm orange is 2.65:1; #1E1B17 is 6.48:1.
		accentOn: INK_ON_BRIGHT_ACCENT,
		fallbackIcon: ({ size = 22, className }) => <EnvelopeIcon size={size} className={className} />,
	},
}

export const DESTINATION_TYPES: ReadonlyArray<AlertDestinationType> = [
	"slack-bot",
	"discord",
	"email",
	"pagerduty",
	"webhook",
	"hazel-oauth",
]

interface ProviderLogoProps {
	type: AlertDestinationType
	size?: number
	/** outer tile class — controls the surrounding chip frame */
	className?: string
	/** when true, suppresses the tile background and shows just the mark */
	bare?: boolean
}

export function ProviderLogo({ type, size = 40, className, bare }: ProviderLogoProps) {
	const provider = PROVIDERS[type]
	const [errored, setErrored] = useState(false)
	const inner = size - 14

	const content = (() => {
		if (provider.brandfetchDomain && !errored) {
			return (
				<img
					src={brandfetchUrl(provider.brandfetchDomain, Math.max(inner * 2, 64))}
					alt={`${provider.label} logo`}
					width={inner}
					height={inner}
					loading="lazy"
					referrerPolicy="no-referrer"
					onError={() => setErrored(true)}
					className="rounded-[6px] object-contain"
					style={{ width: inner, height: inner }}
				/>
			)
		}

		if (provider.monogram || errored) {
			const mono = provider.monogram ?? {
				letter: provider.label[0]!,
				gradient: [provider.accent, provider.accent],
			}
			return (
				<span
					className="flex items-center justify-center rounded-[6px] font-semibold"
					style={{
						width: inner,
						height: inner,
						fontSize: Math.round(inner * 0.55),
						background: `linear-gradient(135deg, ${mono.gradient[0]}, ${mono.gradient[1]})`,
						// Same fill, same ink rule as the save button — this letter is 14px
						// semibold, below the large-text threshold, so white on PagerDuty's
						// green (3.01:1) was too thin even for a logo stand-in.
						color: provider.accentOn,
					}}
				>
					{mono.letter}
				</span>
			)
		}

		if (provider.fallbackIcon) {
			return (
				<span
					className="flex items-center justify-center rounded-[6px]"
					style={{
						width: inner,
						height: inner,
						color: provider.accent,
					}}
				>
					{provider.fallbackIcon({ size: Math.round(inner * 0.65) })}
				</span>
			)
		}

		return null
	})()

	if (bare) {
		return <span className={className}>{content}</span>
	}

	return (
		<span
			className={cn(
				"relative inline-flex shrink-0 items-center justify-center rounded-lg border border-border/60 bg-card",
				className,
			)}
			style={{ width: size, height: size }}
		>
			<span
				aria-hidden
				className="absolute inset-0 rounded-lg opacity-70"
				style={{
					background: `radial-gradient(circle at 30% 20%, ${provider.accentBg}, transparent 70%)`,
				}}
			/>
			<span className="relative">{content}</span>
		</span>
	)
}

export const destinationTypeLabels: Record<AlertDestinationType, string> = Object.fromEntries(
	DESTINATION_TYPES.map((type) => [type, PROVIDERS[type].label]),
) as Record<AlertDestinationType, string>
