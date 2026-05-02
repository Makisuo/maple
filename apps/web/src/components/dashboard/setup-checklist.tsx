import { useEffect, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { motion, AnimatePresence } from "motion/react"
import { toast } from "sonner"
import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent } from "@maple/ui/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@maple/ui/components/ui/tabs"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import {
	CheckIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	CodeIcon,
	CopyIcon,
	EyeIcon,
	PulseIcon,
	XmarkIcon,
} from "@/components/icons"
import { CodeBlock } from "@/components/quick-start/code-block"
import { PackageManagerCodeBlock } from "@/components/quick-start/package-manager-code-block"
import { sdkSnippets, type FrameworkId } from "@/components/quick-start/sdk-snippets"
import {
	NextjsIcon,
	NodejsIcon,
	PythonIcon,
	GoIcon,
	EffectIcon,
	OpenTelemetryIcon,
} from "@/components/quick-start/framework-icons"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { ingestUrl } from "@/lib/services/common/ingest-url"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { getServiceOverviewResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { useQuickStart } from "@/hooks/use-quick-start"
import type { RoleOption } from "@/atoms/quick-start-atoms"
import { cn } from "@maple/ui/utils"

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

function maskKey(key: string): string {
	if (key.length <= 18) return key
	const prefix = key.slice(0, 14)
	const suffix = key.slice(-4)
	return `${prefix}${"•".repeat(key.length - 18)}${suffix}`
}

export function SetupChecklist() {
	const { orgId } = useAuth()
	const {
		selectedFramework,
		setSelectedFramework,
		checklistDismissed,
		dismissChecklist,
		checklistExpanded,
		setChecklistExpanded,
		qualifyAnswers,
	} = useQuickStart(orgId)

	const roleDefault = qualifyAnswers.role ? ROLE_DEFAULT_FRAMEWORK[qualifyAnswers.role] : "nodejs"
	const framework = selectedFramework ?? roleDefault

	const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, "1h")
	const [pollCount, setPollCount] = useState(0)

	const overviewResult = useAtomValue(
		getServiceOverviewResultAtom({
			data: { startTime, endTime },
			_poll: pollCount,
		} as never),
	)

	useEffect(() => {
		if (checklistDismissed) return
		const interval = setInterval(() => setPollCount((c) => c + 1), 15000)
		return () => clearInterval(interval)
	}, [checklistDismissed])

	const services = Result.isSuccess(overviewResult) ? overviewResult.value.data : []
	const realServices = services.filter(
		(s) => !(typeof s.serviceName === "string" && s.serviceName.startsWith("demo-")),
	)
	const hasRealData = realServices.length > 0

	useEffect(() => {
		if (hasRealData && !checklistDismissed) {
			dismissChecklist()
		}
	}, [hasRealData, checklistDismissed, dismissChecklist])

	if (checklistDismissed || hasRealData) return null

	return (
		<Card className="mb-4 border-primary/30 bg-primary/[0.02] overflow-hidden">
			<button
				type="button"
				onClick={() => setChecklistExpanded(!checklistExpanded)}
				className="w-full flex items-center justify-between gap-4 px-5 py-4 text-left hover:bg-muted/30 transition-colors"
			>
				<div className="flex items-center gap-3">
					<div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
						<CodeIcon size={16} />
					</div>
					<div>
						<p className="text-sm font-medium">Connect your app to see real data</p>
						<p className="text-xs text-muted-foreground">
							Drop in the snippet and we'll auto-detect your first traces.
						</p>
					</div>
				</div>
				<div className="flex items-center gap-1">
					<Button
						variant="ghost"
						size="sm"
						aria-label={checklistExpanded ? "Collapse" : "Expand"}
						className="size-8 p-0"
						onClick={(e) => {
							e.stopPropagation()
							setChecklistExpanded(!checklistExpanded)
						}}
					>
						{checklistExpanded ? (
							<ChevronUpIcon size={14} />
						) : (
							<ChevronDownIcon size={14} />
						)}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						aria-label="Dismiss setup checklist"
						className="size-8 p-0"
						onClick={(e) => {
							e.stopPropagation()
							dismissChecklist()
							toast.success("Setup checklist hidden — you can reset it from settings later")
						}}
					>
						<XmarkIcon size={14} />
					</Button>
				</div>
			</button>

			<AnimatePresence initial={false}>
				{checklistExpanded && (
					<motion.div
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{ duration: 0.2 }}
					>
						<CardContent className="border-t border-primary/20 p-5 space-y-5">
							<FrameworkPicker selected={framework} onSelect={setSelectedFramework} />
							<ConnectInstructions framework={framework} />
							<ListeningStatus pollCount={pollCount} />
						</CardContent>
					</motion.div>
				)}
			</AnimatePresence>
		</Card>
	)
}

function FrameworkPicker({
	selected,
	onSelect,
}: {
	selected: FrameworkId
	onSelect: (id: FrameworkId) => void
}) {
	return (
		<div className="space-y-2">
			<span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
				Pick your stack
			</span>
			<div className="flex flex-wrap gap-2">
				{sdkSnippets.map((snippet) => {
					const Icon = frameworkIconMap[snippet.language]
					const active = selected === snippet.language
					return (
						<button
							key={snippet.language}
							type="button"
							onClick={() => onSelect(snippet.language)}
							className={cn(
								"flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
								active
									? "border-primary bg-primary/10 text-primary"
									: "border-border hover:border-foreground/30",
							)}
						>
							<Icon size={14} />
							{snippet.label}
						</button>
					)
				})}
			</div>
		</div>
	)
}

function ConnectInstructions({ framework }: { framework: FrameworkId }) {
	const snippet = sdkSnippets.find((s) => s.language === framework)
	const keysResult = useAtomValue(MapleApiAtomClient.query("ingestKeys", "get", {}))
	const apiKey = Result.isSuccess(keysResult) ? keysResult.value.publicKey : "Loading..."

	if (!snippet) return null

	function interpolate(template: string) {
		return template
			.replace(/\{\{INGEST_URL\}\}/g, ingestUrl)
			.replace(/\{\{API_KEY\}\}/g, apiKey || "<your-api-key>")
	}

	return (
		<div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-5">
			<div className="space-y-3">
				<span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
					Credentials
				</span>
				<CopyableInput value={ingestUrl} label="Ingest endpoint" />
				<CopyableInput value={apiKey} label="API key" masked />
			</div>

			<div className="rounded-lg border bg-card overflow-hidden">
				<Tabs defaultValue="install" className="flex flex-col">
					<div className="border-b px-3">
						<TabsList variant="line" className="h-9">
							<TabsTrigger value="install">Install</TabsTrigger>
							<TabsTrigger value="instrument">Instrument</TabsTrigger>
						</TabsList>
					</div>

					<TabsContent value="install" className="overflow-auto p-3 mt-0">
						{typeof snippet.install === "string" ? (
							<CodeBlock code={snippet.install} language="shell" />
						) : (
							<PackageManagerCodeBlock packages={snippet.install.packages} />
						)}
					</TabsContent>

					<TabsContent value="instrument" className="overflow-auto p-3 mt-0">
						<CodeBlock
							code={interpolate(snippet.instrument)}
							language={snippet.label.toLowerCase()}
						/>
					</TabsContent>
				</Tabs>
			</div>
		</div>
	)
}

function ListeningStatus({ pollCount: _pollCount }: { pollCount: number }) {
	return (
		<div className="flex items-center gap-2.5 rounded-lg border border-dashed border-primary/30 bg-primary/5 px-4 py-3">
			<PulseIcon size={14} className="text-primary animate-pulse" />
			<span className="text-xs text-muted-foreground">Watching for your first trace…</span>
		</div>
	)
}

function CopyableInput({ value, label, masked }: { value: string; label: string; masked?: boolean }) {
	const [copied, setCopied] = useState(false)
	const [isVisible, setIsVisible] = useState(false)

	async function handleCopy() {
		try {
			await navigator.clipboard.writeText(value)
			setCopied(true)
			toast.success(`${label} copied`)
			setTimeout(() => setCopied(false), 1500)
		} catch {
			toast.error(`Failed to copy ${label.toLowerCase()}`)
		}
	}

	return (
		<div className="space-y-1">
			<label className="text-xs text-muted-foreground">{label}</label>
			<InputGroup>
				<InputGroupInput
					readOnly
					value={masked && !isVisible ? maskKey(value) : value}
					className="font-mono text-xs tracking-wide select-all"
				/>
				<InputGroupAddon align="inline-end">
					{masked && (
						<InputGroupButton
							onClick={() => setIsVisible((v) => !v)}
							aria-label={isVisible ? "Hide key" : "Reveal key"}
						>
							<EyeIcon size={14} className={isVisible ? "text-foreground" : undefined} />
						</InputGroupButton>
					)}
					<InputGroupButton onClick={handleCopy} aria-label={`Copy ${label.toLowerCase()}`}>
						{copied ? (
							<CheckIcon size={14} className="text-severity-info" />
						) : (
							<CopyIcon size={14} />
						)}
					</InputGroupButton>
				</InputGroupAddon>
			</InputGroup>
		</div>
	)
}

