import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@maple/ui/components/ui/button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@maple/ui/components/ui/tabs"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import {
  CheckIcon,
  CopyIcon,
  EyeIcon,
  CircleCheckIcon,
  ArrowLeftIcon,
  ClockIcon,
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

const frameworkIconMap: Record<FrameworkId, React.ComponentType<{ size?: number; className?: string }>> = {
  nextjs: NextjsIcon,
  nodejs: NodejsIcon,
  python: PythonIcon,
  go: GoIcon,
  effect: EffectIcon,
  otel: OpenTelemetryIcon,
}

function maskKey(key: string): string {
  if (key.length <= 18) return key
  const prefix = key.slice(0, 14)
  const suffix = key.slice(-4)
  return `${prefix}${"•".repeat(key.length - 18)}${suffix}`
}

function CopyableInput({
  value,
  label,
  masked,
}: {
  value: string
  label: string
  masked?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [isVisible, setIsVisible] = useState(false)

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
    <div className="space-y-1.5">
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
              <EyeIcon
                size={14}
                className={isVisible ? "text-foreground" : undefined}
              />
            </InputGroupButton>
          )}
          <InputGroupButton
            onClick={handleCopy}
            aria-label={`Copy ${label.toLowerCase()}`}
          >
            {copied ? (
              <CheckIcon size={14} className="text-severity-info animate-in zoom-in-50 duration-200" />
            ) : (
              <CopyIcon size={14} />
            )}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

export function StepConnect({
  framework,
  ingestUrl,
  apiKey,
  onBack,
  onContinue,
}: {
  framework: FrameworkId
  ingestUrl: string
  apiKey: string
  onBack: () => void
  onContinue: () => void
}) {
  const snippet = sdkSnippets.find((s) => s.language === framework)
  if (!snippet) return null

  const Icon = frameworkIconMap[framework]

  function interpolate(template: string) {
    return template
      .replace(/\{\{INGEST_URL\}\}/g, ingestUrl)
      .replace(/\{\{API_KEY\}\}/g, apiKey || "<your-api-key>")
  }

  return (
    <div className="flex-1 flex flex-col">
      {/* Main Content */}
      <div className="flex-1 flex gap-0 px-6 lg:px-12 py-8 overflow-hidden">
        {/* Left Column */}
        <div className="w-[340px] shrink-0 flex flex-col gap-8 pr-8">
          {/* Framework badge */}
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon size={16} />
            </div>
            <span className="text-sm font-medium text-muted-foreground">
              {snippet.label}
            </span>
          </div>

          {/* Heading */}
          <div className="space-y-2">
            <h2 className="text-3xl font-semibold tracking-tight">
              Connect your app
            </h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Copy your credentials and add the instrumentation snippet to start
              sending traces.
            </p>
          </div>

          {/* Credentials */}
          <div className="space-y-4">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Your Credentials
            </span>
            <CopyableInput value={ingestUrl} label="Ingest Endpoint" />
            <CopyableInput value={apiKey} label="API Key" masked />
          </div>

          {/* Reassurance */}
          <div className="space-y-3 pt-2">
            <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
              <CircleCheckIcon size={16} className="text-severity-info shrink-0" />
              Keys are read-only and safe to commit
            </div>
            <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
              <ClockIcon size={16} className="shrink-0" />
              Usually takes under 30 seconds
            </div>
            <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
              <CircleCheckIcon size={16} className="text-severity-info shrink-0" />
              Zero-config auto-instrumentation
            </div>
          </div>
        </div>

        {/* Right Column — Code Panel */}
        <div className="flex-1 min-w-0 rounded-xl border bg-card overflow-hidden flex flex-col">
          {/* Terminal Header */}
          <div className="border-b bg-muted/40 px-4 py-3 flex items-center gap-3">
            <div className="flex gap-1.5">
              <div className="size-2.5 rounded-full bg-border" />
              <div className="size-2.5 rounded-full bg-border" />
              <div className="size-2.5 rounded-full bg-border" />
            </div>
          </div>

          {/* Code Tabs */}
          <Tabs defaultValue="install" className="flex-1 flex flex-col">
            <div className="border-b px-4">
              <TabsList variant="line" className="h-10">
                <TabsTrigger value="install">Install</TabsTrigger>
                <TabsTrigger value="instrument">Instrument</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="install" className="flex-1 overflow-auto p-5 space-y-5 mt-0">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Step 1 — Install packages
                  </span>
                </div>
                {typeof snippet.install === "string" ? (
                  <CodeBlock code={snippet.install} language="shell" />
                ) : (
                  <PackageManagerCodeBlock packages={snippet.install.packages} />
                )}
              </div>
            </TabsContent>

            <TabsContent value="instrument" className="flex-1 overflow-auto p-5 space-y-5 mt-0">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Add to your instrumentation file
                  </span>
                </div>
                <CodeBlock
                  code={interpolate(snippet.instrument)}
                  language={snippet.label.toLowerCase()}
                />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {/* Bottom Bar */}
      <div className="flex items-center justify-between px-6 lg:px-12 py-4 border-t">
        <Button variant="ghost" onClick={onBack} className="gap-2">
          <ArrowLeftIcon size={14} />
          Back
        </Button>
        <Button size="lg" onClick={onContinue} className="gap-2">
          Verify Connection
          <span>&rarr;</span>
        </Button>
      </div>
    </div>
  )
}
