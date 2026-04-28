import { useState, useMemo } from "react"
import { Link } from "@tanstack/react-router"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { MagnifierIcon, CircleCheckIcon, ChevronRightIcon, ClockIcon } from "@/components/icons"
import {
	NextjsIcon,
	NodejsIcon,
	PythonIcon,
	GoIcon,
	EffectIcon,
	OpenTelemetryIcon,
} from "@/components/quick-start/framework-icons"
import { sdkSnippets, type FrameworkId } from "@/components/quick-start/sdk-snippets"
import { cn } from "@maple/ui/utils"

const frameworkIconMap: Record<FrameworkId, React.ComponentType<{ size?: number; className?: string }>> = {
	nextjs: NextjsIcon,
	nodejs: NodejsIcon,
	python: PythonIcon,
	go: GoIcon,
	effect: EffectIcon,
	otel: OpenTelemetryIcon,
}

const popularSnippets = sdkSnippets.filter((s) => s.language !== "otel")
const otelSnippet = sdkSnippets.find((s) => s.language === "otel")!

export function StepWelcome({
	selectedFramework,
	onSelectFramework,
	onContinue,
}: {
	selectedFramework: FrameworkId | null
	onSelectFramework: (id: FrameworkId) => void
	onContinue: () => void
}) {
	const [search, setSearch] = useState("")

	const filteredSnippets = useMemo(() => {
		if (!search.trim()) return popularSnippets
		const term = search.toLowerCase()
		return popularSnippets.filter(
			(s) => s.label.toLowerCase().includes(term) || s.description.toLowerCase().includes(term),
		)
	}, [search])

	const selectedLabel = selectedFramework
		? sdkSnippets.find((s) => s.language === selectedFramework)?.label
		: null

	return (
		<div className="flex-1 flex flex-col items-center justify-center px-6 py-12">
			<div className="w-full max-w-[680px] flex flex-col items-center gap-8">
				{/* Badge */}
				<div className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
					<ClockIcon size={14} />
					Takes about 2 minutes
				</div>

				{/* Heading */}
				<div className="text-center space-y-3">
					<h1 className="text-4xl font-semibold tracking-tight">What are you building with?</h1>
					<p className="text-muted-foreground text-[15px] leading-relaxed max-w-md mx-auto">
						Pick your stack and we'll generate everything you need. First traces in under 5
						minutes.
					</p>
				</div>

				{/* Search */}
				<div className="relative w-full">
					<MagnifierIcon
						size={16}
						className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
					/>
					<Input
						placeholder="Search frameworks, languages, or runtimes..."
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						className="pl-10 h-11"
					/>
				</div>

				{/* Popular Label */}
				<div className="flex items-center gap-3 w-full">
					<span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
						Popular
					</span>
					<div className="flex-1 h-px bg-border" />
				</div>

				{/* Framework Grid */}
				<div className="w-full space-y-3">
					<div className="grid grid-cols-3 gap-3">
						{filteredSnippets.map((snippet) => {
							const Icon = frameworkIconMap[snippet.language]
							const isActive = selectedFramework === snippet.language
							return (
								<button
									key={snippet.language}
									type="button"
									onClick={() => onSelectFramework(snippet.language)}
									className={cn(
										"relative flex items-center gap-3 rounded-xl border px-4 py-3.5 text-left transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring",
										isActive
											? "border-primary bg-primary/5"
											: "border-border hover:border-foreground/30",
									)}
								>
									<div
										className={cn(
											"flex size-8 shrink-0 items-center justify-center rounded-lg",
											isActive
												? "bg-primary/10 text-primary"
												: "bg-muted text-muted-foreground",
										)}
									>
										<Icon size={16} />
									</div>
									<div className="min-w-0">
										<p className="text-sm font-medium truncate">{snippet.label}</p>
										<p className="text-xs text-muted-foreground truncate">
											{snippet.description}
										</p>
									</div>
									{isActive && (
										<CircleCheckIcon
											size={16}
											className="absolute top-2.5 right-2.5 text-primary"
										/>
									)}
								</button>
							)
						})}
					</div>

					{/* Custom / OpenTelemetry */}
					{(!search.trim() ||
						otelSnippet.label.toLowerCase().includes(search.toLowerCase()) ||
						otelSnippet.description.toLowerCase().includes(search.toLowerCase())) && (
						<button
							type="button"
							onClick={() => onSelectFramework("otel")}
							className={cn(
								"relative flex items-center gap-4 rounded-xl border px-5 py-4 w-full text-left transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring",
								selectedFramework === "otel"
									? "border-primary bg-primary/5"
									: "border-border hover:border-foreground/30",
							)}
						>
							<div
								className={cn(
									"flex size-10 shrink-0 items-center justify-center rounded-lg",
									selectedFramework === "otel"
										? "bg-primary/10 text-primary"
										: "bg-muted text-muted-foreground",
								)}
							>
								<OpenTelemetryIcon size={20} />
							</div>
							<div className="flex-1 min-w-0">
								<p className="text-sm font-medium">Custom / OpenTelemetry</p>
								<p className="text-sm text-muted-foreground">
									Any language or runtime — just point your OTLP exporter at Maple
								</p>
							</div>
							<ChevronRightIcon size={16} className="text-muted-foreground shrink-0" />
						</button>
					)}
				</div>

				{/* Continue Button */}
				<Button
					size="lg"
					disabled={!selectedFramework}
					onClick={onContinue}
					className="w-full max-w-xs"
				>
					{selectedLabel ? `Continue with ${selectedLabel}` : "Select a framework"}
					<span className="ml-2">&rarr;</span>
				</Button>

				{/* Skip Link */}
				<p className="text-sm text-muted-foreground">
					Already set up?{" "}
					<Link to="/" className="text-primary hover:underline">
						Skip to dashboard
					</Link>
				</p>

				{/* Social Proof */}
				<div className="flex items-center gap-2.5 text-xs text-muted-foreground pt-2">
					<div className="flex -space-x-1.5">
						{["bg-chart-p50", "bg-chart-p95", "bg-chart-p99", "bg-severity-info"].map((bg, i) => (
							<div
								key={i}
								className={cn("size-6 rounded-full border-2 border-background", bg)}
							/>
						))}
					</div>
					Trusted by 120+ engineering teams
				</div>
			</div>
		</div>
	)
}
