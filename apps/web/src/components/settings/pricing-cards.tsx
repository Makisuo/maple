import { useState } from "react"
import { useCustomer, usePricingTable } from "autumn-js/react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { PLAN_LIMITS, type PlanLimits } from "@/lib/billing/plans"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  FileIcon,
  PulseIcon,
  ChartLineIcon,
  ClockIcon,
} from "@/components/icons"
import type { IconComponent } from "@/components/icons"

const PLAN_META: Record<
  string,
  { price: string; interval?: string; description: string }
> = {
  free: { price: "$0", description: "For hobby projects and evaluation" },
  pro: {
    price: "$49",
    interval: "/mo",
    description: "For production workloads",
  },
  enterprise: {
    price: "Custom",
    description: "For teams with advanced needs",
  },
}

function formatLimit(value: number): string {
  if (!isFinite(value)) return "Unlimited"
  return `${value} GB`
}

const PLAN_FEATURES: {
  icon: IconComponent
  label: string
  getValue: (limits: PlanLimits) => string
}[] = [
  { icon: FileIcon, label: "Logs", getValue: (l) => formatLimit(l.logsGB) },
  {
    icon: PulseIcon,
    label: "Traces",
    getValue: (l) => formatLimit(l.tracesGB),
  },
  {
    icon: ChartLineIcon,
    label: "Metrics",
    getValue: (l) => formatLimit(l.metricsGB),
  },
  {
    icon: ClockIcon,
    label: "Retention",
    getValue: (l) => `${l.retentionDays}d`,
  },
]

function formatCurrency(amountCents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(amountCents / 100)
}

function getButtonConfig(scenario: string | undefined) {
  switch (scenario) {
    case "active":
      return { label: "Current plan", variant: "secondary" as const, disabled: true }
    case "scheduled":
      return { label: "Scheduled", variant: "secondary" as const, disabled: true }
    case "upgrade":
      return { label: "Upgrade", variant: "default" as const, disabled: false }
    case "downgrade":
      return { label: "Downgrade", variant: "outline" as const, disabled: false }
    case "cancel":
      return { label: "Resubscribe", variant: "outline" as const, disabled: false }
    case "new":
    case "renew":
    default:
      return { label: "Subscribe", variant: "outline" as const, disabled: false }
  }
}

interface CheckoutPreview {
  productId: string
  productName: string
  lines: { description: string; amount: number }[]
  total: number
  currency: string
  nextCycle?: { starts_at: number; total: number }
}

export function PricingCards() {
  const { products, isLoading, error } = usePricingTable()
  const { checkout, attach, refetch } = useCustomer()
  const [loadingProductId, setLoadingProductId] = useState<string | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<CheckoutPreview | null>(
    null,
  )
  const [isAttaching, setIsAttaching] = useState(false)

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-3 w-16" />
              <Skeleton className="mt-2 h-6 w-20" />
              <Skeleton className="mt-1 h-3 w-32" />
            </CardHeader>
            <CardContent className="space-y-3">
              {Array.from({ length: 4 }).map((_, j) => (
                <Skeleton key={j} className="h-4 w-full" />
              ))}
            </CardContent>
            <CardFooter>
              <Skeleton className="h-8 w-full" />
            </CardFooter>
          </Card>
        ))}
      </div>
    )
  }

  if (error || !products) {
    return (
      <p className="text-muted-foreground text-sm">
        Unable to load pricing plans.
      </p>
    )
  }

  async function handleCheckout(productId: string, buttonUrl?: string) {
    if (buttonUrl) {
      window.open(buttonUrl, "_blank", "noopener")
      return
    }

    setLoadingProductId(productId)
    try {
      const result = await checkout({ productId })

      if (result.error) {
        toast.error(result.error.message)
        return
      }

      if (result.data.url) {
        window.location.href = result.data.url
        return
      }

      setConfirmDialog({
        productId,
        productName: result.data.product?.name ?? productId,
        lines: result.data.lines.map((l) => ({
          description: l.description,
          amount: l.amount,
        })),
        total: result.data.total,
        currency: result.data.currency,
        nextCycle: result.data.next_cycle,
      })
    } catch {
      toast.error("Something went wrong. Please try again.")
    } finally {
      setLoadingProductId(null)
    }
  }

  async function handleConfirmAttach() {
    if (!confirmDialog) return
    setIsAttaching(true)
    try {
      const result = await attach({ productId: confirmDialog.productId })
      if (result.error) {
        toast.error(result.error.message)
        return
      }
      toast.success("Plan updated successfully.")
      await refetch()
      setConfirmDialog(null)
    } catch {
      toast.error("Something went wrong. Please try again.")
    } finally {
      setIsAttaching(false)
    }
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {products.map((product) => {
          const isActive = product.scenario === "active"
          const limits = PLAN_LIMITS[product.id]
          const meta = PLAN_META[product.id]
          const btn = getButtonConfig(product.scenario)
          const trialAvailable = product.free_trial?.trial_available

          return (
            <Card
              key={product.id}
              className={cn(
                isActive && "ring-primary/40",
              )}
            >
              <CardHeader>
                <div className="flex items-center gap-2">
                  <CardTitle className="text-xs font-medium uppercase tracking-widest">
                    {product.display?.name ?? product.name}
                  </CardTitle>
                  {isActive && (
                    <Badge variant="secondary" className="text-[10px]">
                      Current
                    </Badge>
                  )}
                  {product.display?.recommend_text && !isActive && (
                    <Badge variant="outline" className="text-[10px]">
                      {product.display.recommend_text}
                    </Badge>
                  )}
                </div>
                <div className="mt-1 flex items-baseline gap-0.5">
                  <span className="text-lg font-medium">
                    {meta?.price ?? product.display?.name ?? product.name}
                  </span>
                  {meta?.interval && (
                    <span className="text-muted-foreground text-xs">
                      {meta.interval}
                    </span>
                  )}
                </div>
                {meta?.description && (
                  <CardDescription>{meta.description}</CardDescription>
                )}
                {product.display?.everything_from && (
                  <p className="text-muted-foreground text-xs">
                    Everything in {product.display.everything_from}, plus:
                  </p>
                )}
              </CardHeader>

              {limits && (
                <CardContent>
                  <Separator className="mb-3" />
                  <div className="space-y-2">
                    {PLAN_FEATURES.map((feature) => {
                      const Icon = feature.icon
                      return (
                        <div
                          key={feature.label}
                          className="flex items-center justify-between"
                        >
                          <div className="text-muted-foreground flex items-center gap-2">
                            <Icon className="size-3.5" />
                            <span>{feature.label}</span>
                          </div>
                          <span className="tabular-nums">
                            {feature.getValue(limits)}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </CardContent>
              )}

              <CardFooter>
                <Button
                  variant={btn.variant}
                  disabled={btn.disabled || loadingProductId === product.id}
                  className="w-full"
                  onClick={() =>
                    handleCheckout(product.id, product.display?.button_url)
                  }
                >
                  {loadingProductId === product.id ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <>
                      {btn.label}
                      {trialAvailable && !btn.disabled && " — Start free trial"}
                    </>
                  )}
                </Button>
              </CardFooter>
            </Card>
          )
        })}
      </div>

      <Dialog
        open={confirmDialog !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDialog(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm plan change</DialogTitle>
            <DialogDescription>
              You're switching to{" "}
              <span className="text-foreground font-medium">
                {confirmDialog?.productName}
              </span>
              .
            </DialogDescription>
          </DialogHeader>

          {confirmDialog && (
            <div className="space-y-2 text-xs">
              {confirmDialog.lines.map((line, i) => (
                <div key={i} className="flex justify-between">
                  <span className="text-muted-foreground">
                    {line.description}
                  </span>
                  <span className="tabular-nums">
                    {formatCurrency(line.amount, confirmDialog.currency)}
                  </span>
                </div>
              ))}
              <Separator />
              <div className="flex justify-between font-medium">
                <span>Due today</span>
                <span className="tabular-nums">
                  {formatCurrency(confirmDialog.total, confirmDialog.currency)}
                </span>
              </div>
              {confirmDialog.nextCycle && (
                <p className="text-muted-foreground text-xs">
                  Then{" "}
                  {formatCurrency(
                    confirmDialog.nextCycle.total,
                    confirmDialog.currency,
                  )}{" "}
                  starting{" "}
                  {new Date(
                    confirmDialog.nextCycle.starts_at * 1000,
                  ).toLocaleDateString()}
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDialog(null)}
              disabled={isAttaching}
            >
              Cancel
            </Button>
            <Button onClick={handleConfirmAttach} disabled={isAttaching}>
              {isAttaching ? <Spinner className="size-3.5" /> : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
