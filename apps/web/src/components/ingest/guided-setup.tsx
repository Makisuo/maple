import { useAuth } from "@clerk/clerk-react"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { cn } from "@maple/ui/utils"
import { CodeBlock } from "@/components/quick-start/code-block"
import { PackageManagerCodeBlock } from "@/components/quick-start/package-manager-code-block"
import {
	EffectIcon,
	GoIcon,
	NextjsIcon,
	NodejsIcon,
	OpenTelemetryIcon,
	PythonIcon,
} from "@/components/quick-start/framework-icons"
import { sdkSnippets, type FrameworkId } from "@/components/quick-start/sdk-snippets"
import { ingestUrl } from "@/lib/services/common/ingest-url"
import { useQuickStart } from "@/hooks/use-quick-start"
import type { RoleOption } from "@/atoms/quick-start-atoms"
import { CopyableField } from "./copyable-field"

const frameworkIconMap: Record<FrameworkId, React.ComponentType<{ size?: number; className?: string }>> = {
	nextjs: NextjsIcon,
	nodejs: NodejsIcon,
	python: PythonIcon,
	go: GoIcon,
	effect: EffectIcon,
	otel: OpenTelemetryIcon,
}

const ROLE_DEFAULT_FRAMEWORK: Record<RoleOption, FrameworkId> = {
	engineer: "nodejs",
	devops_sre: "otel",
	eng_leader: "nodejs",
	founder: "nextjs",
}

interface GuidedSetupProps {
	/** Public ingest key, interpolated into the instrument snippet. */
	apiKey: string
	/** Render the endpoint + key credentials column beside the snippet tabs. */
	showCredentials?: boolean
}

/**
 * Per-org framework selection for the guided ingestion flow, defaulting from the
 * quick-start qualify answers. Shared by `GuidedSetup` and the ingestion
 * settings page (which composes the picker into its own section header).
 */
export function useGuidedFramework() {
	const { orgId } = useAuth()
	const { selectedFramework, setSelectedFramework, qualifyAnswers } = useQuickStart(orgId)

	const roleDefault = qualifyAnswers.role ? ROLE_DEFAULT_FRAMEWORK[qualifyAnswers.role] : "nodejs"
	return { framework: selectedFramework ?? roleDefault, setFramework: setSelectedFramework }
}

/**
 * Framework picker + Install / Instrument / Claude Code tabs. The shared body of
 * the guided ingestion flow, used by the dashboard setup checklist and the
 * ingestion settings page. Selection persists via the per-org quick-start atom.
 */
export function GuidedSetup({ apiKey, showCredentials = false }: GuidedSetupProps) {
	const { framework, setFramework } = useGuidedFramework()

	return (
		<div className="space-y-4">
			<FrameworkPicker selected={framework} onSelect={setFramework} />
			<ConnectInstructions
				framework={framework}
				apiKey={apiKey}
				showCredentials={showCredentials}
			/>
		</div>
	)
}

export function FrameworkPicker({
	selected,
	onSelect,
	compact = false,
}: {
	selected: FrameworkId
	onSelect: (id: FrameworkId) => void
	/** Pill chips without the "Pick your stack" label — for section headers. */
	compact?: boolean
}) {
	const chips = (
		<div className="flex flex-wrap gap-1.5">
			{sdkSnippets.map((snippet) => {
				const Icon = frameworkIconMap[snippet.language]
				const active = selected === snippet.language
				return (
					<button
						key={snippet.language}
						type="button"
						onClick={() => onSelect(snippet.language)}
						className={cn(
							"flex items-center gap-1.5 border font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
							compact
								? "rounded-full px-2.5 py-1 font-mono text-[11px] leading-3.5"
								: "rounded-lg px-3 py-2 text-xs gap-2",
							active
								? compact
									? "border-primary text-primary"
									: "border-primary bg-primary/10 text-primary"
								: compact
									? "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
									: "border-border hover:border-foreground/30",
						)}
					>
						<Icon size={compact ? 12 : 14} />
						{snippet.label}
					</button>
				)
			})}
		</div>
	)

	if (compact) return chips

	return (
		<div className="space-y-2">
			<span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
				Pick your stack
			</span>
			{chips}
		</div>
	)
}

export function ConnectInstructions({
	framework,
	apiKey,
	showCredentials = false,
	variant = "boxed",
}: {
	framework: FrameworkId
	apiKey: string
	showCredentials?: boolean
	/** `flush` drops the outer border/background so the tabs sit directly in a parent card. */
	variant?: "boxed" | "flush"
}) {
	const snippet = sdkSnippets.find((s) => s.language === framework)

	if (!snippet) return null

	const contentPadding = variant === "boxed" ? "p-3" : "px-4 pt-3 pb-4"

	function interpolate(template: string) {
		return template
			.replace(/\{\{INGEST_URL\}\}/g, ingestUrl)
			.replace(/\{\{API_KEY\}\}/g, apiKey || "<your-api-key>")
	}

	const tabs = (
		<div className={variant === "boxed" ? "rounded-lg border bg-card overflow-hidden" : undefined}>
			<Tabs defaultValue="install" className="flex flex-col">
				<div className={cn("border-b", variant === "boxed" ? "px-3" : "px-4")}>
					<TabsList variant="underline" className="h-9">
						<TabsTrigger value="install">Install</TabsTrigger>
						<TabsTrigger value="instrument">Instrument</TabsTrigger>
						<TabsTrigger value="claude-code">Claude Code</TabsTrigger>
					</TabsList>
				</div>

				<TabsContent value="install" className={cn("overflow-auto mt-0", contentPadding)}>
					{typeof snippet.install === "string" ? (
						<CodeBlock code={snippet.install} language="shell" />
					) : (
						<PackageManagerCodeBlock packages={snippet.install.packages} />
					)}
				</TabsContent>

				<TabsContent value="instrument" className={cn("overflow-auto mt-0", contentPadding)}>
					<CodeBlock code={interpolate(snippet.instrument)} language={snippet.label.toLowerCase()} />
				</TabsContent>

				<TabsContent value="claude-code" className={cn("overflow-auto mt-0 space-y-2", contentPadding)}>
					<p className="text-xs text-muted-foreground">
						Run this prompt in Claude Code (or Codex / Cursor with the skill installed). The{" "}
						<code className="rounded bg-muted px-1">maple-onboard</code> skill walks every service
						in the repo, installs OpenTelemetry, wires traces / logs / metrics, and verifies the
						bootstrap end-to-end.
					</p>
					<CodeBlock
						code={`Install Maple in this repo using the maple-onboard skill.\nMy ingest key is ${apiKey || "<your-api-key>"}.`}
						language="shell"
					/>
				</TabsContent>
			</Tabs>
		</div>
	)

	if (!showCredentials) return tabs

	return (
		<div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-5">
			<div className="space-y-3">
				<span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
					Credentials
				</span>
				<CopyableField value={ingestUrl} label="Ingest endpoint" />
				<CopyableField value={apiKey || "Loading…"} label="API key" masked />
			</div>
			{tabs}
		</div>
	)
}
