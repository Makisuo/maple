import { useEffect, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { useNavigate } from "@tanstack/react-router"
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
	CircleCheckIcon,
	CodeIcon,
	CopyIcon,
	EyeIcon,
	PaperPlaneIcon,
	PulseIcon,
	RocketIcon,
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
		demoDataRequested,
	} = useQuickStart(orgId)

	const roleDefault = qualifyAnswers.role ? ROLE_DEFAULT_FRAMEWORK[qualifyAnswers.role] : "nodejs"
	const framework = selectedFramework ?? roleDefault

	const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, "1h")
	const [pollCount, setPollCount] = useState(0)

	const keysResult = useAtomValue(MapleApiAtomClient.query("ingestKeys", "get", {}))
	const apiKey = Result.isSuccess(keysResult) ? keysResult.value.publicKey : ""

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
	const firstRealService =
		typeof realServices[0]?.serviceName === "string"
			? (realServices[0].serviceName as string)
			: undefined

	if (checklistDismissed) return null

	if (hasRealData) {
		return <FirstTraceCelebration serviceName={firstRealService} onDismiss={dismissChecklist} />
	}

	return (
		<Card className="mb-4 shrink-0 border-primary/30 bg-primary/[0.02] overflow-hidden">
			<div className="flex items-center justify-between gap-4 pr-3">
				<button
					type="button"
					onClick={() => setChecklistExpanded(!checklistExpanded)}
					className="flex flex-1 min-w-0 items-center gap-3 px-5 py-4 text-left hover:bg-muted/30 transition-colors"
				>
					<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
						<CodeIcon size={16} />
					</div>
					<div className="min-w-0">
						<p className="text-sm font-medium">
							{demoDataRequested
								? "Demo data is in — now connect your real app"
								: "Connect your app to see real data"}
						</p>
						<p className="text-xs text-muted-foreground">
							{demoDataRequested
								? "You're exploring sample services. Send your own telemetry to see your real stack."
								: "Drop in the snippet and we'll auto-detect your first traces."}
						</p>
					</div>
				</button>
				<div className="flex items-center gap-1 shrink-0">
					<Button
						variant="ghost"
						size="sm"
						aria-label={checklistExpanded ? "Collapse" : "Expand"}
						className="size-8 p-0"
						onClick={() => setChecklistExpanded(!checklistExpanded)}
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
						onClick={() => {
							dismissChecklist()
							toast.success("Setup checklist hidden — you can reset it from settings later")
						}}
					>
						<XmarkIcon size={14} />
					</Button>
				</div>
			</div>

			<div
				className="grid transition-[grid-template-rows] duration-200 ease-out"
				style={{ gridTemplateRows: checklistExpanded ? "1fr" : "0fr" }}
			>
				<div className="overflow-hidden">
					<CardContent className="border-t border-primary/20 p-5 space-y-5">
						<FrameworkPicker selected={framework} onSelect={setSelectedFramework} />
						<ConnectInstructions framework={framework} apiKey={apiKey} />
						<ListeningStatus
							apiKey={apiKey}
							onTestSent={() => setPollCount((c) => c + 1)}
						/>
					</CardContent>
				</div>
			</div>
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

function ConnectInstructions({ framework, apiKey }: { framework: FrameworkId; apiKey: string }) {
	const snippet = sdkSnippets.find((s) => s.language === framework)

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
				<CopyableInput value={apiKey || "Loading…"} label="API key" masked />
			</div>

			<div className="rounded-lg border bg-card overflow-hidden">
				<Tabs defaultValue="install" className="flex flex-col">
					<div className="border-b px-3">
						<TabsList variant="line" className="h-9">
							<TabsTrigger value="install">Install</TabsTrigger>
							<TabsTrigger value="instrument">Instrument</TabsTrigger>
							<TabsTrigger value="claude-code">Claude Code</TabsTrigger>
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

					<TabsContent value="claude-code" className="overflow-auto p-3 mt-0 space-y-2">
						<p className="text-xs text-muted-foreground">
							Run this prompt in Claude Code (or Codex / Cursor with the skill
							installed). The <code className="rounded bg-muted px-1">maple-onboard</code>{" "}
							skill walks every service in the repo, installs OpenTelemetry, wires
							traces / logs / metrics, and verifies the bootstrap end-to-end.
						</p>
						<CodeBlock
							code={`Install Maple in this repo using the maple-onboard skill.\nMy ingest key is ${apiKey || "<your-api-key>"}.`}
							language="shell"
						/>
					</TabsContent>
				</Tabs>
			</div>
		</div>
	)
}

function ListeningStatus({
	apiKey,
	onTestSent,
}: {
	apiKey: string
	onTestSent: () => void
}) {
	const [sending, setSending] = useState(false)

	async function handleSendTest() {
		if (!apiKey || sending) return
		setSending(true)
		try {
			await sendTestEvent(apiKey)
			toast.success("Test event sent — watch for it to land below")
			onTestSent()
		} catch {
			toast.error("Couldn't reach the ingest endpoint — double-check your API key")
		} finally {
			setSending(false)
		}
	}

	return (
		<div className="flex flex-col gap-3 rounded-lg border border-dashed border-primary/30 bg-primary/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
			<div className="flex items-center gap-2.5">
				<PulseIcon size={14} className="text-primary animate-pulse" />
				<span className="text-xs text-muted-foreground">
					Watching for your first trace…
				</span>
			</div>
			<div className="flex items-center gap-2">
				<span className="hidden text-[11px] text-muted-foreground sm:inline">
					Not ready to instrument?
				</span>
				<Button
					variant="outline"
					size="sm"
					onClick={handleSendTest}
					disabled={sending || !apiKey}
					className="gap-2 shrink-0"
				>
					<PaperPlaneIcon size={13} />
					{sending ? "Sending…" : "Send a test event"}
				</Button>
			</div>
		</div>
	)
}

function FirstTraceCelebration({
	serviceName,
	onDismiss,
}: {
	serviceName?: string
	onDismiss: () => void
}) {
	const navigate = useNavigate()

	function handleExplore() {
		onDismiss()
		if (serviceName) {
			navigate({ to: "/traces", search: { services: [serviceName] } })
		} else {
			navigate({ to: "/traces" })
		}
	}

	return (
		<Card className="mb-4 shrink-0 border-primary/40 bg-primary/[0.04] overflow-hidden">
			<CardContent className="flex items-center gap-4 p-5">
				<div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
					<CircleCheckIcon size={20} />
				</div>
				<div className="flex-1 min-w-0">
					<p className="text-sm font-semibold tracking-tight">
						First trace received — you're live
					</p>
					<p className="text-xs text-muted-foreground mt-0.5">
						{serviceName
							? `We're seeing telemetry from ${serviceName}. Open it to explore.`
							: "We're seeing your telemetry. Jump in to explore."}
					</p>
				</div>
				<Button size="sm" onClick={handleExplore} className="gap-2 shrink-0">
					Explore your traces
					<RocketIcon size={14} />
				</Button>
				<Button
					variant="ghost"
					size="sm"
					aria-label="Dismiss"
					className="size-8 p-0 shrink-0"
					onClick={onDismiss}
				>
					<XmarkIcon size={14} />
				</Button>
			</CardContent>
		</Card>
	)
}

function randomHex(byteLength: number): string {
	const bytes = new Uint8Array(byteLength)
	crypto.getRandomValues(bytes)
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

const TEST_EVENT_SERVICE = "maple-onboarding-test"

async function sendTestEvent(apiKey: string): Promise<void> {
	const now = Date.now()
	const endNano = `${now}000000`
	const startNano = `${now - 87}000000`
	const payload = {
		resourceSpans: [
			{
				resource: {
					attributes: [
						{ key: "service.name", value: { stringValue: TEST_EVENT_SERVICE } },
						{ key: "deployment.environment", value: { stringValue: "development" } },
					],
				},
				scopeSpans: [
					{
						scope: { name: "maple-onboarding" },
						spans: [
							{
								traceId: randomHex(16),
								spanId: randomHex(8),
								name: "GET /maple/test-event",
								kind: 2,
								startTimeUnixNano: startNano,
								endTimeUnixNano: endNano,
								attributes: [
									{ key: "http.request.method", value: { stringValue: "GET" } },
									{ key: "http.route", value: { stringValue: "/maple/test-event" } },
									{ key: "http.response.status_code", value: { intValue: 200 } },
								],
								status: { code: 1 },
							},
						],
					},
				],
			},
		],
	}

	const response = await fetch(`${ingestUrl}/v1/traces`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(payload),
	})
	if (!response.ok) {
		throw new Error(`Ingest gateway returned ${response.status}`)
	}
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

