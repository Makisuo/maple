import { useEffect, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Result, useAtomValue } from "@effect-atom/atom-react"
import { useAuth } from "@clerk/clerk-react"
import { toast } from "sonner"
import { motion, AnimatePresence } from "motion/react"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import {
  Card,
  CardContent,
} from "@maple/ui/components/ui/card"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@maple/ui/components/ui/input-group"
import { Button } from "@maple/ui/components/ui/button"
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
import { PackageManagerCodeBlock } from "@/components/quick-start/package-manager-code-block"
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
import { cn } from "@maple/ui/utils"

import { useCustomer } from "autumn-js/react"
import { hasSelectedPlan } from "@/lib/billing/plan-gating"
import { PricingCards } from "@/components/settings/pricing-cards"

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

function FrameworkGrid({
  selected,
  onSelect,
}: {
  selected: FrameworkId | null
  onSelect: (id: FrameworkId) => void
}) {
  return (
    <div className="space-y-3">
      <label className="text-sm font-medium">Choose your framework</label>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {sdkSnippets.map((snippet) => {
          const Icon = frameworkIconMap[snippet.iconKey]
          const isActive = selected === snippet.language
          return (
            <button
              key={snippet.language}
              type="button"
              onClick={() => onSelect(snippet.language)}
              className={cn(
                "relative group flex flex-col items-start gap-3 rounded-xl border p-4 text-left transition-all duration-200 ease-out outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                isActive
                  ? "border-foreground bg-card shadow-sm"
                  : "border-border bg-transparent hover:border-foreground/50 hover:bg-muted/30"
              )}
            >
              <div
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors",
                  isActive ? "bg-foreground text-background" : "bg-muted text-muted-foreground group-hover:text-foreground"
                )}
              >
                <Icon size={18} />
              </div>
              <div>
                <p className={cn("text-sm font-medium", isActive ? "text-foreground" : "text-foreground/80")}>
                  {snippet.label}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {snippet.description}
                </p>
              </div>
              {isActive && (
                <div className="absolute top-3 right-3 text-foreground">
                  <CircleCheckIcon size={16} />
                </div>
              )}
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
    <div className="space-y-8">
      <FrameworkGrid selected={selectedFramework} onSelect={onSelectFramework} />

      {snippet && (
        <div className="space-y-8">
          <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
            <div className="border-b bg-muted/40 px-4 py-3 flex items-center gap-2">
              <div className="flex gap-1.5">
                <div className="size-2.5 rounded-full bg-border" />
                <div className="size-2.5 rounded-full bg-border" />
                <div className="size-2.5 rounded-full bg-border" />
              </div>
              <span className="text-xs font-medium text-muted-foreground ml-2">Credentials</span>
            </div>
            <div className="p-4 grid gap-4 sm:grid-cols-2 bg-card">
              <CopyableInput value={ingestUrl} label="Ingest Endpoint" />
              <CopyableInput value={displayKey} label="API Key" />
            </div>
          </div>

          <div className="space-y-6">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[10px] font-bold">1</span>
                <h4 className="text-sm font-medium">Install dependencies</h4>
              </div>
              <div className="pl-7">
                {typeof snippet.install === "string" ? (
                  <CodeBlock code={snippet.install} language="shell" />
                ) : (
                  <PackageManagerCodeBlock packages={snippet.install.packages} />
                )}
              </div>
            </div>
            
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[10px] font-bold">2</span>
                <h4 className="text-sm font-medium">Add instrumentation</h4>
              </div>
              <div className="pl-7">
                <CodeBlock
                  code={interpolate(snippet.instrument)}
                  language={snippet.label.toLowerCase()}
                />
              </div>
            </div>
          </div>

          {!isComplete && (
            <div className="flex justify-end pt-4">
              <Button size="lg" onClick={onComplete} className="group">
                Continue to Verification
                <motion.span
                  className="inline-block ml-2"
                  initial={{ x: 0 }}
                  whileHover={{ x: 4 }}
                  transition={{ type: "spring", stiffness: 400, damping: 25 }}
                >
                  &rarr;
                </motion.span>
              </Button>
            </div>
          )}
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

  return (
    <div className="flex flex-col items-center justify-center py-20">
      <div className="relative flex items-center justify-center size-64 mb-8">
        {/* Radar / Pulse Animation */}
        {!isComplete && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <motion.div
              className="absolute size-20 rounded-full border border-primary"
              initial={{ scale: 1, opacity: 0 }}
              animate={{ scale: [1, 1.2, 3], opacity: [0, 0.4, 0] }}
              transition={{ duration: 3, repeat: Infinity, times: [0, 0.1, 1], ease: "linear", delay: 0 }}
            />
            <motion.div
              className="absolute size-20 rounded-full border border-primary"
              initial={{ scale: 1, opacity: 0 }}
              animate={{ scale: [1, 1.2, 3], opacity: [0, 0.4, 0] }}
              transition={{ duration: 3, repeat: Infinity, times: [0, 0.1, 1], ease: "linear", delay: 1 }}
            />
            <motion.div
              className="absolute size-20 rounded-full border border-primary"
              initial={{ scale: 1, opacity: 0 }}
              animate={{ scale: [1, 1.2, 3], opacity: [0, 0.4, 0] }}
              transition={{ duration: 3, repeat: Infinity, times: [0, 0.1, 1], ease: "linear", delay: 2 }}
            />
            <div className="absolute size-32 rounded-full bg-primary/5 blur-2xl animate-pulse" />
          </div>
        )}

        {/* Center Icon */}
        <div className="relative z-10 flex size-20 items-center justify-center rounded-2xl bg-card shadow-xl border border-border overflow-hidden">
          <AnimatePresence mode="wait">
            {isComplete ? (
              <motion.div
                key="success"
                initial={{ scale: 0, rotate: -180 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: "spring", stiffness: 300, damping: 20 }}
                className="text-emerald-500"
              >
                <CircleCheckIcon size={40} />
              </motion.div>
            ) : (
              <motion.div
                key="waiting"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, scale: 0.5 }}
                className="text-muted-foreground/50"
              >
                <PulseIcon size={32} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {isComplete ? (
          <motion.div
            key="success-text"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center space-y-4 max-w-sm"
          >
            <h3 className="text-xl font-semibold text-emerald-500">Data Detected!</h3>
            <p className="text-sm text-muted-foreground">
              Your instrumentation is working perfectly. Telemetry data is flowing into Maple.
            </p>
            <Button size="lg" onClick={onComplete} className="w-full group bg-emerald-500 hover:bg-emerald-600 text-white border-none">
              Continue to Billing
              <motion.span
                className="inline-block ml-2"
                initial={{ x: 0 }}
                whileHover={{ x: 4 }}
                transition={{ type: "spring", stiffness: 400, damping: 25 }}
              >
                &rarr;
              </motion.span>
            </Button>
          </motion.div>
        ) : (
          <motion.div
            key="waiting-text"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, y: -10 }}
            className="text-center space-y-6 max-w-sm"
          >
            <div className="space-y-2">
              <h3 className="text-xl font-medium">Listening for events...</h3>
              <p className="text-sm text-muted-foreground">
                Run your instrumented application. We'll automatically detect when the first traces or logs arrive.
              </p>
            </div>
            
            <div className="bg-muted/40 rounded-lg p-4 border border-border border-dashed text-left">
              <p className="text-xs font-medium text-foreground mb-2">Need a test event?</p>
              <p className="text-xs text-muted-foreground">
                Try running the app and triggering a route or endpoint to generate initial telemetry data.
              </p>
            </div>

            <Button size="sm" variant="ghost" onClick={onComplete} className="text-muted-foreground hover:text-foreground">
              Skip verification for now
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function StepSelectPlan({
  isComplete,
  onComplete,
}: {
  isComplete: boolean
  onComplete: () => void
}) {
  const { customer, isLoading } = useCustomer()
  const selectedPlan = hasSelectedPlan(customer)

  // Auto-complete if they already selected a plan
  useEffect(() => {
    if (selectedPlan && !isComplete) {
      onComplete()
    }
  }, [selectedPlan, isComplete, onComplete])

  if (isComplete) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="relative z-10 flex size-20 items-center justify-center rounded-2xl bg-card shadow-xl border border-emerald-500/30 overflow-hidden mb-8 text-emerald-500">
          <CircleCheckIcon size={40} />
        </div>
        <div className="text-center space-y-4 max-w-sm">
          <h3 className="text-xl font-semibold text-emerald-500">Plan Selected!</h3>
          <p className="text-sm text-muted-foreground">
            Your workspace is fully activated and ready to go.
          </p>
          <Button size="lg" onClick={onComplete} className="w-full group bg-emerald-500 hover:bg-emerald-600 text-white border-none mt-4">
            Continue to Explore
            <motion.span
              className="inline-block ml-2"
              initial={{ x: 0 }}
              whileHover={{ x: 4 }}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
            >
              &rarr;
            </motion.span>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div className="space-y-2 text-center max-w-lg mx-auto mb-10">
        <h2 className="text-2xl font-semibold tracking-tight">Choose your plan</h2>
        <p className="text-muted-foreground text-sm">
          Select a billing plan to permanently enable your workspace and start exploring your data.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <PulseIcon className="animate-spin text-muted-foreground" size={24} />
        </div>
      ) : (
        <div className="w-full -mx-4 sm:mx-0 px-4 sm:px-0">
          <PricingCards />
        </div>
      )}
    </div>
  )
}

function StepExplore({ onComplete }: { onComplete: () => void }) {
  const links = [
    {
      title: "Overview",
      description: "See your golden signals, error rates, and p99 latency at a glance across all services.",
      href: "/",
      icon: HouseIcon,
      bg: "bg-blue-500/5",
      border: "hover:border-blue-500/50 group-hover:bg-blue-500/10",
      iconColor: "text-blue-500",
    },
    {
      title: "Traces",
      description: "Dive deep into distributed traces. Find the root cause of slow requests and unhandled exceptions.",
      href: "/traces",
      icon: PulseIcon,
      bg: "bg-purple-500/5",
      border: "hover:border-purple-500/50 group-hover:bg-purple-500/10",
      iconColor: "text-purple-500",
    },
    {
      title: "Logs",
      description: "Search, filter, and alert on application logs correlated automatically with trace context.",
      href: "/logs",
      icon: FileIcon,
      bg: "bg-emerald-500/5",
      border: "hover:border-emerald-500/50 group-hover:bg-emerald-500/10",
      iconColor: "text-emerald-500",
    },
  ]

  return (
    <div className="space-y-8">
      <div className="space-y-2 text-center max-w-lg mx-auto">
        <div className="inline-flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary mb-4 ring-8 ring-primary/5">
          <RocketIcon size={24} />
        </div>
        <h2 className="text-2xl font-semibold tracking-tight">You're ready to fly</h2>
        <p className="text-muted-foreground text-sm">
          Maple is now ingesting your telemetry. Choose an area below to start investigating performance and debugging issues.
        </p>
      </div>

      <div className="grid gap-4">
        {links.map((link) => (
          <Link key={link.href} to={link.href} onClick={onComplete} className="group block outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-xl">
            <Card
              className={cn(
                "relative overflow-hidden border bg-card transition-all duration-300 ease-out hover:shadow-md hover:-translate-y-[2px]",
                link.border
              )}
            >
              <div className={cn("absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none", link.bg)} />
              
              <CardContent className="p-6">
                <div className="flex items-start gap-5">
                  <div className={cn("flex size-12 shrink-0 items-center justify-center rounded-xl bg-background border shadow-sm transition-colors duration-300", link.iconColor, link.border.split(' ')[1])}>
                    <link.icon size={24} />
                  </div>
                  <div className="space-y-1.5 flex-1">
                    <h3 className="text-lg font-medium group-hover:text-foreground transition-colors">{link.title}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {link.description}
                    </p>
                  </div>
                  <div className="shrink-0 pt-2 text-muted-foreground/40 group-hover:text-foreground transition-colors transform group-hover:translate-x-1 duration-300">
                    &rarr;
                  </div>
                </div>
              </CardContent>
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
    id: "select-plan",
    title: "Select your plan",
    description: "Choose a billing plan to permanently enable your workspace",
  },
  {
    id: "explore",
    title: "Explore your data",
    description: "Navigate your traces, logs, and metrics",
  },
]

function QuickStartPage() {
  const { orgId } = useAuth()
  const {
    activeStep,
    setActiveStep,
    completeStep,
    isStepComplete,
    isDismissed,
    dismiss,
    undismiss,
    reset,
    selectedFramework,
    setSelectedFramework,
  } = useQuickStart(orgId)

  // --- Page-level auto-completion (runs regardless of active step) ---
  const { customer } = useCustomer()
  const { startTime, endTime } = useEffectiveTimeRange(undefined, undefined, "1h")

  const overviewResult = useAtomValue(
    getServiceOverviewResultAtom({
      data: { startTime, endTime },
    } as any),
  )

  // Auto-complete "verify-data" if data already exists
  useEffect(() => {
    if (isStepComplete("verify-data")) return
    if (Result.isSuccess(overviewResult) && overviewResult.value.data.length > 0) {
      completeStep("verify-data")
    }
  }, [overviewResult])

  // Auto-complete "select-plan" if plan already selected
  useEffect(() => {
    if (isStepComplete("select-plan")) return
    if (hasSelectedPlan(customer)) {
      completeStep("select-plan")
    }
  }, [customer])

  return (
    <DashboardLayout
      breadcrumbs={[{ label: "Quick Start" }]}
      title="Quick Start"
      description="Connect your application and start monitoring performance."
      headerActions={
        <div className="flex items-center gap-2">
          {!isDismissed ? (
            <Button size="sm" variant="outline" onClick={dismiss} className="h-8 shadow-sm">
              Hide from sidebar
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={undismiss} className="h-8 shadow-sm">
              Show in sidebar
            </Button>
          )}
        </div>
      }
    >
      <div className="mx-auto w-full max-w-6xl py-8">
        {isDismissed && (
          <div className="mb-8 flex items-center justify-between rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground shadow-sm">
            <span>Hidden from sidebar. Access this page via direct URL.</span>
            <Button size="sm" variant="secondary" onClick={undismiss} className="h-7">
              Restore
            </Button>
          </div>
        )}

        <div className="grid lg:grid-cols-[320px_1fr] gap-12 lg:gap-16 items-start">
          
          {/* Left Column: Navigation / Timeline */}
          <div className="lg:sticky lg:top-24 space-y-8">
            
            {/* Hero / Value Prop */}
            <div className="space-y-3">
              <h1 className="text-3xl font-semibold tracking-tight">Setup Maple</h1>
              <p className="text-muted-foreground text-[15px] leading-relaxed">
                Get complete visibility in 5 minutes. Connect your app to start exploring traces, logs, and metrics instantly.
              </p>
            </div>

            {/* Stepper Navigation */}
            <nav aria-label="Progress" className="relative mt-8">
              <div className="absolute left-[15px] top-6 bottom-6 w-[2px] bg-muted -z-10" />
              <ul role="list" className="space-y-6">
                {STEPS.map((step, index) => {
                  const complete = isStepComplete(step.id)
                  const isActive = activeStep === step.id
                  const isPast = index < STEPS.findIndex((s) => s.id === activeStep)
                  const previousStepComplete = index === 0 ? true : isStepComplete(STEPS[index - 1].id)
                  const isClickable = complete || isActive || isPast || previousStepComplete
                  
                  return (
                    <li key={step.id}>
                      <button
                        onClick={() => setActiveStep(step.id)}
                        disabled={!isClickable}
                        className={cn(
                          "group relative flex w-full items-start gap-4 outline-none transition-opacity",
                          !isClickable && "opacity-50 cursor-not-allowed",
                          isActive && "opacity-100"
                        )}
                        aria-current={isActive ? "step" : undefined}
                      >
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-background mt-0.5 shadow-[0_0_0_4px_hsl(var(--background))] z-10">
                          {complete ? (
                            <span className="flex size-7 items-center justify-center rounded-full bg-emerald-500 text-white shadow-sm ring-1 ring-emerald-500/20 transition-all group-hover:bg-emerald-600">
                              <CheckIcon size={14} className="stroke-[3]" />
                            </span>
                          ) : isActive ? (
                            <span className="flex size-7 items-center justify-center rounded-full border-2 border-primary bg-background shadow-sm ring-4 ring-primary/10">
                              <span className="size-2.5 rounded-full bg-primary animate-pulse" />
                            </span>
                          ) : (
                            <span className="flex size-7 items-center justify-center rounded-full border-2 border-muted-foreground/30 bg-background text-xs font-medium text-muted-foreground transition-colors group-hover:border-muted-foreground/50">
                              {index + 1}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-col text-left pt-1">
                          <span className={cn(
                            "text-sm font-semibold tracking-tight transition-colors",
                            isActive ? "text-foreground" : complete ? "text-foreground/80" : "text-muted-foreground"
                          )}>
                            {step.title}
                          </span>
                          <span className="text-sm text-muted-foreground line-clamp-2 mt-0.5">
                            {step.description}
                          </span>
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </nav>

            <div className="pt-6 border-t">
              <Button variant="ghost" size="sm" onClick={reset} className="text-muted-foreground hover:text-foreground">
                Reset progress
              </Button>
            </div>
          </div>

          {/* Right Column: Main Content */}
          <div className="relative min-w-0 min-h-[500px] bg-background rounded-2xl sm:border p-0 sm:p-8 sm:shadow-sm">
            <AnimatePresence mode="wait">
              {activeStep === "setup-app" && (
                <motion.div
                  key="setup-app"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.3, ease: "easeInOut" }}
                >
                  <StepSetupApp
                    selectedFramework={selectedFramework}
                    onSelectFramework={setSelectedFramework}
                    onComplete={() => completeStep("setup-app")}
                    isComplete={isStepComplete("setup-app")}
                  />
                </motion.div>
              )}
              {activeStep === "verify-data" && (
                <motion.div
                  key="verify-data"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.3, ease: "easeInOut" }}
                >
                  <StepVerifyData
                    isComplete={isStepComplete("verify-data")}
                    onComplete={() => completeStep("verify-data")}
                  />
                </motion.div>
              )}
              {activeStep === "select-plan" && (
                <motion.div
                  key="select-plan"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.3, ease: "easeInOut" }}
                >
                  <StepSelectPlan
                    isComplete={isStepComplete("select-plan")}
                    onComplete={() => completeStep("select-plan")}
                  />
                </motion.div>
              )}
              {activeStep === "explore" && (
                <motion.div
                  key="explore"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.3, ease: "easeInOut" }}
                >
                  <StepExplore
                    onComplete={() => completeStep("explore")}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>

        </div>
      </div>
    </DashboardLayout>
  )
}
