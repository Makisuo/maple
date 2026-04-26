import type { AlertDestinationType } from "@maple/domain/http"
import { useState, type ReactNode } from "react"
import { CodeIcon, HazelIcon } from "@/components/icons"
import { cn } from "@maple/ui/utils"

const BRANDFETCH_CLIENT_ID = "1id0IQ-4i8Z46-n-DfQ"

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
  /** readable brand color for text/borders on dark surfaces — falls back to `accent` if omitted */
  accentText?: string
  brandfetchDomain?: string
  monogram?: { letter: string; gradient: [string, string] }
  fallbackIcon?: (props: { size?: number; className?: string }) => ReactNode
  docsUrl?: string
  docsLabel?: string
}

export const PROVIDERS: Record<AlertDestinationType, DestinationProvider> = {
  slack: {
    type: "slack",
    label: "Slack",
    description: "Post alerts to a Slack channel via incoming webhook.",
    accent: "#4A154B",
    accentBg: "rgba(74,21,75,0.30)",
    accentText: "#E8C5EA",
    brandfetchDomain: "slack.com",
    docsUrl: "https://api.slack.com/messaging/webhooks",
    docsLabel: "Slack webhook docs",
  },
  pagerduty: {
    type: "pagerduty",
    label: "PagerDuty",
    description: "Trigger incidents through a PagerDuty Events v2 routing key.",
    accent: "#06AC38",
    accentBg: "rgba(6,172,56,0.16)",
    brandfetchDomain: "pagerduty.com",
    docsUrl: "https://support.pagerduty.com/main/docs/services-and-integrations",
    docsLabel: "PagerDuty integration guide",
  },
  webhook: {
    type: "webhook",
    label: "Webhook",
    description: "POST a signed JSON payload to any HTTP endpoint you control.",
    accent: "#F59E0B",
    accentBg: "rgba(245,158,11,0.16)",
    fallbackIcon: ({ size = 22, className }) => <CodeIcon size={size} className={className} />,
  },
  hazel: {
    type: "hazel",
    label: "Hazel (webhook)",
    description: "Legacy webhook integration — paste the URL Hazel issues you.",
    accent: "#F46F0F",
    accentBg: "rgba(244,111,15,0.16)",
    fallbackIcon: ({ size = 22, className }) => <HazelIcon size={size} className={className} />,
    docsUrl: "https://hazel.sh/docs/integrations/maple",
    docsLabel: "Hazel integration guide",
  },
  "hazel-oauth": {
    type: "hazel-oauth",
    label: "Hazel",
    description: "Connect Hazel via OAuth and pick a workspace to route alerts into.",
    accent: "#F46F0F",
    accentBg: "rgba(244,111,15,0.16)",
    fallbackIcon: ({ size = 22, className }) => <HazelIcon size={size} className={className} />,
    docsUrl: "https://hazel.sh/docs/integrations/maple",
    docsLabel: "Hazel integration guide",
  },
}

export const DESTINATION_TYPES: ReadonlyArray<AlertDestinationType> = [
  "slack",
  "pagerduty",
  "webhook",
  "hazel-oauth",
  "hazel",
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
      const mono = provider.monogram ?? { letter: provider.label[0]!, gradient: [provider.accent, provider.accent] }
      return (
        <span
          className="flex items-center justify-center rounded-[6px] font-semibold text-white"
          style={{
            width: inner,
            height: inner,
            fontSize: Math.round(inner * 0.55),
            background: `linear-gradient(135deg, ${mono.gradient[0]}, ${mono.gradient[1]})`,
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
