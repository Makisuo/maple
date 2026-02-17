import { useEffect, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Result, useAtomValue } from "@effect-atom/atom-react"
import { toast } from "sonner"
import { motion, AnimatePresence } from "motion/react"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import {
  CheckIcon,
  CopyIcon,
  CircleCheckIcon,
  RocketIcon,
  HouseIcon,
  PulseIcon,
  FileIcon,
} from "@/components/icons"
import { CodeBlock } from "@/components/quick-start/code-block"
import { sdkSnippets, type FrameworkId } from "@/components/quick-start/sdk-snippets"
import {
  NextjsIcon,
  NodejsIcon,
  PythonIcon,
  GoIcon,
  EffectIcon,
} from "@/components/quick-start/framework-icons"
import { useQuickStart, type StepId } from "@/hooks/use-quick-start"
import { ingestUrl } from "@/lib/services/common/ingest-url"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { getServiceOverviewResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/quick-start")({
  component: QuickStartPage,
})

const frameworkIconMap: Record<FrameworkId, React.ComponentType<{ size?: number; className?: string }>> = {
  nextjs: NextjsIcon,
  nodejs: NodejsIcon,
  python: PythonIcon,
  go: GoIcon,
  effect: EffectIcon,
}

function StepIndicator({
  stepNumber,
  isComplete,
}: {
  stepNumber: number
  isComplete: boolean
}) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      {isComplete ? (
        <motion.span
          key="complete"
          initial={{ scale: 0, rotate: -90 }}
          animate={{ scale: 1, rotate: 0 }}
          exit={{ scale: 0 }}
          transition={{ type: "spring", stiffness: 500, damping: 25 }}
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500"
        >
          <CheckIcon size={14} />
        </motion.span>
      ) : (
        <motion.span
          key="number"
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          exit={{ scale: 0 }}
          transition={{ type: "spring", stiffness: 500, damping: 25 }}
          className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-xs font-medium text-muted-foreground"
        >
          {stepNumber}
        </motion.span>
      )}
    </AnimatePresence>
  )
}

function CopyableInput({
  value,
  label,
}: {
  value: string
  label: string
}) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      toast.success(`${label} copied to clipboard`)
      setTimeout(() => setCopied(false), 2000)
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
          value={value}
          className="font-mono text-xs tracking-wide select-all"
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            onClick={handleCopy}
            aria-label={`Copy ${label.toLowerCase()}`}
            title={copied ? "Copied!" : "Copy"}
          >
            {copied ? (
              <CheckIcon size={14} className="text-emerald-500 animate-in zoom-in-50 duration-200" />
            ) : (
              <CopyIcon size={14} />
            )}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

function FrameworkPills({
  selected,
  onSelect,
}: {
  selected: FrameworkId | null
  onSelect: (id: FrameworkId) => void
}) {
  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-muted-foreground">Framework</label>
      <div className="flex flex-wrap gap-2">
        {sdkSnippets.map((snippet) => {
          const Icon = frameworkIconMap[snippet.iconKey]
          const isActive = selected === snippet.language
          return (
            <button
              key={snippet.language}
              type="button"
              onClick={() => onSelect(snippet.language)}
              className={cn(
                "relative inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                isActive
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {isActive && (
                <motion.div
                  layoutId="framework-pill-bg"
                  className="absolute inset-0 rounded-full border border-foreground/20 bg-muted"
                  transition={{ type: "spring", stiffness: 400, damping: 30 }}
                />
              )}
              <span className="relative z-10 inline-flex items-center gap-1.5">
                <Icon size={14} />
                {snippet.label}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function StepSetupApp({
  selectedFramework,
  onSelectFramework,
  onComplete,
  isComplete,
}: {
  selectedFramework: FrameworkId | null
  onSelectFramework: (id: FrameworkId) => void
  onComplete: () => void
  isComplete: boolean
}) {
  const keysResult = useAtomValue(
    MapleApiAtomClient.query("ingestKeys", "get", {}),
  )

  const displayKey = Result.builder(keysResult)
    .onSuccess((v) => v.publicKey)
    .orElse(() => "Loading...")

  const apiKey = Result.isSuccess(keysResult) ? keysResult.value.publicKey : null

  function interpolate(template: string) {
    return template
      .replace(/\{\{INGEST_URL\}\}/g, ingestUrl)
      .replace(/\{\{API_KEY\}\}/g, apiKey ?? "<your-api-key>")
  }

  const snippet = sdkSnippets.find((s) => s.language === selectedFramework)

  return (
    <div className="space-y-5">
      <FrameworkPills selected={selectedFramework} onSelect={onSelectFramework} />

      <div className="grid gap-3 sm:grid-cols-2">
        <CopyableInput value={ingestUrl} label="Ingest Endpoint" />
        <CopyableInput value={displayKey} label="API Key" />
      </div>

      {snippet ? (
        <>
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground">1. Install dependencies</h4>
            <CodeBlock code={snippet.install} language="shell" />
          </div>
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground">2. Add instrumentation</h4>
            <CodeBlock
              code={interpolate(snippet.instrument)}
              language={snippet.label.toLowerCase()}
            />
          </div>
          {!isComplete && (
            <Button size="sm" variant="outline" onClick={onComplete}>
              Mark as done
              <CheckIcon size={14} />
            </Button>
          )}
        </>
      ) : (
        <div className="flex items-center justify-center border border-dashed border-border rounded-md py-8">
          <p className="text-xs text-muted-foreground">
            Select a framework above to see setup instructions.
          </p>
        </div>
      )}
    </div>
  )
}

function StepVerifyData({
  isComplete,
  onComplete,
}: {
  isComplete: boolean
  onComplete: () => void
}) {
  const [pollCount, setPollCount] = useState(0)
  const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, "1h")

  useEffect(() => {
    if (isComplete) return

    const interval = setInterval(() => {
      setPollCount((c) => c + 1)
    }, 5000)

    return () => clearInterval(interval)
  }, [isComplete])

  const overviewResult = useAtomValue(
    getServiceOverviewResultAtom({
      data: {
        startTime,
        endTime,
      },
      _poll: pollCount,
    } as any),
  )

  useEffect(() => {
    if (isComplete) return

    if (Result.isSuccess(overviewResult) && overviewResult.value.data.length > 0) {
      onComplete()
    }
  }, [overviewResult, isComplete, onComplete])

  if (isComplete) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: "spring", stiffness: 400, damping: 25 }}
        className="space-y-3"
      >
        <div className="flex items-center gap-2 text-emerald-500">
          <motion.span
            initial={{ scale: 0, rotate: -90 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: "spring", stiffness: 500, damping: 25, delay: 0.15 }}
          >
            <CircleCheckIcon size={16} />
          </motion.span>
          <span className="text-xs font-medium">Data detected! Your telemetry is flowing.</span>
        </div>
      </motion.div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Run your instrumented application. We'll automatically detect when data arrives.
      </p>
      <div className="flex items-center gap-2 text-muted-foreground">
        <div className="flex items-center gap-1">
          <span className="pulse-dot size-1.5 rounded-full bg-current" />
          <span className="pulse-dot size-1.5 rounded-full bg-current" />
          <span className="pulse-dot size-1.5 rounded-full bg-current" />
        </div>
        <span className="text-xs">Waiting for data...</span>
      </div>
      <Button size="sm" variant="ghost" onClick={onComplete}>
        Skip — I'll verify later
      </Button>
    </div>
  )
}

function StepExplore({ onComplete }: { onComplete: () => void }) {
  const links = [
    { title: "Overview", description: "See all your services at a glance", href: "/", icon: HouseIcon },
    { title: "Traces", description: "Explore distributed traces", href: "/traces", icon: PulseIcon },
    { title: "Logs", description: "Search and filter your logs", href: "/logs", icon: FileIcon },
  ]

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Start exploring your observability data.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {links.map((link, i) => (
          <Link key={link.href} to={link.href} onClick={onComplete}>
            <Card
              className="hover:bg-muted/50 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 cursor-pointer animate-in fade-in slide-in-from-bottom-2 fill-mode-backwards"
              style={{ animationDelay: `${i * 75}ms`, animationDuration: "400ms" }}
            >
              <CardHeader className="p-3">
                <div className="flex items-center gap-2">
                  <link.icon size={14} className="text-muted-foreground" />
                  <CardTitle className="text-xs">{link.title}</CardTitle>
                </div>
                <CardDescription className="text-[11px]">
                  {link.description}
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}

const STEPS: {
  id: StepId
  title: string
  description: string
}[] = [
  {
    id: "setup-app",
    title: "Set up your app",
    description: "Choose your framework, grab your credentials, and add instrumentation",
  },
  {
    id: "verify-data",
    title: "Verify data is flowing",
    description: "Run your app — we'll auto-detect when telemetry arrives",
  },
  {
    id: "explore",
    title: "Explore your data",
    description: "Navigate your traces, logs, and metrics",
  },
]

function QuickStartPage() {
  const {
    completeStep,
    isStepComplete,
    completedCount,
    totalSteps,
    progressPercent,
    isDismissed,
    isComplete,
    dismiss,
    undismiss,
    reset,
    selectedFramework,
    setSelectedFramework,
  } = useQuickStart()

  return (
    <DashboardLayout
      breadcrumbs={[{ label: "Quick Start" }]}
      title="Quick Start"
      description="Get your first traces flowing."
      headerActions={
        <div className="flex items-center gap-2">
          {!isDismissed ? (
            <Button size="sm" variant="ghost" onClick={dismiss}>
              Hide from sidebar
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={undismiss}>
              Show in sidebar
            </Button>
          )}
        </div>
      }
    >
      <div className="max-w-2xl space-y-6">
        {isDismissed && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            Hidden from sidebar.{" "}
            <button
              type="button"
              onClick={undismiss}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Show again
            </button>
          </div>
        )}

        <AnimatePresence>
          {isComplete && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
            >
              <Card className="border-emerald-500/30 bg-emerald-500/5">
                <CardContent className="flex items-center gap-3 p-4">
                  <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 500, damping: 25, delay: 0.2 }}
                  >
                    <RocketIcon size={20} className="shrink-0 text-emerald-500" />
                  </motion.span>
                  <div>
                    <p className="text-sm font-medium">You're all set!</p>
                    <p className="text-xs text-muted-foreground">
                      All steps completed. Head to the{" "}
                      <Link to="/" className="underline underline-offset-2 hover:text-foreground">
                        Overview
                      </Link>{" "}
                      to see your data.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="animate-in fade-in slide-in-from-bottom-2 duration-400 fill-mode-backwards">
          <Progress value={progressPercent}>
            <ProgressLabel>Setup progress</ProgressLabel>
            <ProgressValue>
              {() => `${completedCount} of ${totalSteps} completed`}
            </ProgressValue>
          </Progress>
        </div>

        <div>
          {STEPS.map((step, index) => {
            const complete = isStepComplete(step.id)
            const isLast = index === STEPS.length - 1
            return (
              <div
                key={step.id}
                className="grid grid-cols-[24px_1fr] gap-x-3 animate-in fade-in slide-in-from-bottom-2 duration-400 fill-mode-backwards"
                style={{ animationDelay: `${(index + 1) * 75}ms` }}
              >
                {/* Col 1: indicator + vertical connector */}
                <div className="flex flex-col items-center">
                  <StepIndicator stepNumber={index + 1} isComplete={complete} />
                  {!isLast && (
                    <div className="relative mt-2 flex-1 w-px min-h-4">
                      <div className="absolute inset-0 bg-border" />
                      {complete && (
                        <motion.div
                          className="absolute inset-0 bg-emerald-500/40"
                          initial={{ scaleY: 0 }}
                          animate={{ scaleY: 1 }}
                          style={{ transformOrigin: "top" }}
                          transition={{ duration: 0.4, ease: "easeOut" }}
                        />
                      )}
                    </div>
                  )}
                </div>

                {/* Col 2: header + content */}
                <div className={cn("pb-8", isLast && "pb-0")}>
                  <h3 className="text-sm font-medium">{step.title}</h3>
                  <p className="text-xs text-muted-foreground mb-4">{step.description}</p>
                  <div className={cn("transition-opacity duration-300", complete && "opacity-50")}>
                    {step.id === "setup-app" && (
                      <StepSetupApp
                        selectedFramework={selectedFramework}
                        onSelectFramework={setSelectedFramework}
                        onComplete={() => completeStep("setup-app")}
                        isComplete={isStepComplete("setup-app")}
                      />
                    )}
                    {step.id === "verify-data" && (
                      <StepVerifyData
                        isComplete={isStepComplete("verify-data")}
                        onComplete={() => completeStep("verify-data")}
                      />
                    )}
                    {step.id === "explore" && (
                      <StepExplore
                        onComplete={() => completeStep("explore")}
                      />
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        <div className="pt-2">
          <button
            type="button"
            onClick={reset}
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Reset progress
          </button>
        </div>
      </div>
    </DashboardLayout>
  )
}
