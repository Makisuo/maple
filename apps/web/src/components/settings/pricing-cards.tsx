import { useState } from "react"
import { useCustomer, usePricingTable } from "autumn-js/react"
import { toast } from "sonner"

type Product = NonNullable<
  ReturnType<typeof usePricingTable>["products"]
>[number]
type ProductItem = Product["items"][number]

import { cn } from "@maple/ui/utils"
import { getPlanFeatures, getPlanDescription } from "@/lib/billing/plans"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@maple/ui/components/ui/card"
import { Button } from "@maple/ui/components/ui/button"
import { Badge } from "@maple/ui/components/ui/badge"
import { Separator } from "@maple/ui/components/ui/separator"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Spinner } from "@maple/ui/components/ui/spinner"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@maple/ui/components/ui/dialog"
import {
  FileIcon,
  PulseIcon,
  ChartLineIcon,
  CircleCheckIcon,
} from "@/components/icons"
import type { IconComponent } from "@/components/icons"

const FEATURE_ICONS: Record<string, IconComponent> = {
  logs: FileIcon,
  traces: PulseIcon,
  metrics: ChartLineIcon,
}

function getProductSlug(product: Product): string {
  if (product.properties.is_free) return "starter"
  const id = product.id?.toLowerCase()
  if (id === "starter" || id === "startup") return id
  const name = product.name?.toLowerCase()
  if (name === "starter" || name === "startup") return name
  return "startup"
}

function getProductPrice(product: Product): {
  price: string
  interval?: string
} {
  if (product.properties.is_free) return { price: "$0" }
  const baseItem = product.items.find(
    (i) => !i.feature_id && i.price != null,
  )
  if (baseItem?.price != null) {
    return {
      price: `$${baseItem.price}`,
      interval: baseItem.interval ? `/${baseItem.interval}` : undefined,
    }
  }
  return { price: product.display?.name ?? product.name }
}

function formatIncludedUsage(item: ProductItem): string {
  if (item.included_usage === "inf") return "Unlimited"
  if (item.included_usage != null) {
    return `${Number(item.included_usage)} GB`
  }
  return ""
}

function normalizeDetailText(text: string): string {
  return text.replace(/\bper\s+[\d,]+\s+(Logs|Traces|Metrics)\b/i, "per GB")
}

function getFeatureRows(product: Product) {
  return product.items
    .filter((item) => item.feature_id)
    .map((item) => ({
      featureId: item.feature_id ?? "",
      label: item.feature?.name ?? item.feature_id ?? "",
      value: formatIncludedUsage(item),
      detail: item.display?.secondary_text
        ? normalizeDetailText(item.display.secondary_text)
        : undefined,
    }))
}

const ENTERPRISE_DATA_FEATURES = [
  { featureId: "logs", label: "Logs", value: "Custom" },
  { featureId: "traces", label: "Traces", value: "Custom" },
  { featureId: "metrics", label: "Metrics", value: "Custom" },
]

function getButtonConfig(product: Product) {
  const { scenario, properties } = product

  if (product.display?.button_text) {
    const disabled = scenario === "active" && !properties.updateable
    return {
      label: product.display.button_text,
      variant: (scenario === "active" ? "secondary" : "default") as
        | "default"
        | "secondary"
        | "outline",
      disabled,
    }
  }

  switch (scenario) {
    case "active":
      return {
        label: "Current plan",
        variant: "secondary" as const,
        disabled: true,
      }
    case "scheduled":
      return {
        label: "Scheduled",
        variant: "secondary" as const,
        disabled: true,
      }
    case "upgrade":
      return {
        label: "Upgrade",
        variant: "default" as const,
        disabled: false,
      }
    case "downgrade":
      return {
        label: "Downgrade",
        variant: "outline" as const,
        disabled: false,
      }
    case "cancel":
      return {
        label: "Resubscribe",
        variant: "outline" as const,
        disabled: false,
      }
    case "new":
    case "renew":
    default:
      return {
        label: "Subscribe",
        variant: "outline" as const,
        disabled: false,
      }
  }
}

function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(amount)
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-3 w-16" />
              <Skeleton className="mt-2 h-7 w-24" />
              <Skeleton className="mt-1 h-3 w-32" />
            </CardHeader>
            <CardContent className="space-y-3">
              <Skeleton className="h-3 w-20" />
              {Array.from({ length: 3 }).map((_, j) => (
                <Skeleton key={j} className="h-4 w-full" />
              ))}
              <Skeleton className="mt-2 h-px w-full" />
              <Skeleton className="h-3 w-24" />
              {Array.from({ length: 6 }).map((_, j) => (
                <Skeleton key={`f${j}`} className="h-3.5 w-full" />
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

  function handleEnterpriseContact() {
    window.location.href = "mailto:support@maple.dev"
  }

  const enterprisePlanFeatures = getPlanFeatures("enterprise")

  return (
    <div className="space-y-4">
      {/* Normal Plans Grid */}
      <div
        className={cn(
          "grid grid-cols-1 gap-4",
          products.length === 2 && "sm:grid-cols-2",
          products.length >= 3 && "sm:grid-cols-3",
        )}
      >
        {products.map((product) => {
          const isActive = product.scenario === "active"
          const isUpgrade =
            !isActive && product.scenario === "upgrade"
          const { price, interval } = getProductPrice(product)
          const features = getFeatureRows(product)
          const planFeatures = getPlanFeatures(getProductSlug(product))
          const btn = getButtonConfig(product)
          const trialAvailable = product.free_trial?.trial_available

          return (
            <Card
              key={product.id}
              className={cn(
                "flex flex-col relative transition-all duration-300 ease-out",
                isActive && "ring-primary/20 bg-muted/30",
                isUpgrade && "ring-primary/40 ring-2 shadow-[0_0_40px_-15px_rgba(var(--primary),0.3)] scale-[1.02] z-10",
                !isUpgrade && "hover:ring-primary/20",
              )}
            >
              {isUpgrade && (
                <div className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent" />
              )}
              <CardHeader className="pt-6">
                <div className="flex items-center justify-between">
                  <CardTitle className={cn(
                    "text-[11px] font-semibold uppercase tracking-widest",
                    isUpgrade ? "text-primary" : "text-muted-foreground"
                  )}>
                    {product.display?.name ?? product.name}
                  </CardTitle>
                  <div className="flex gap-2">
                    {isActive && (
                      <Badge variant="secondary" className="text-[10px] font-medium bg-secondary/50">
                        Current
                      </Badge>
                    )}
                    {product.display?.recommend_text && !isActive && (
                      <Badge variant="default" className="text-[10px] font-medium shadow-sm">
                        {product.display.recommend_text}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="text-4xl font-semibold tracking-tight tabular-nums">
                    {price}
                  </span>
                  {interval && (
                    <span className="text-muted-foreground text-xs font-medium uppercase tracking-wider ml-1">
                      {interval}
                    </span>
                  )}
                </div>
                <CardDescription className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  {product.display?.description ?? getPlanDescription(getProductSlug(product))}
                </CardDescription>
                {product.display?.everything_from && (
                  <p className="text-muted-foreground mt-3 text-xs font-medium">
                    Everything in <span className="text-foreground">{product.display.everything_from}</span>, plus:
                  </p>
                )}
              </CardHeader>

              <CardContent className="flex flex-col gap-6 flex-1 pt-2 pb-6">
                {features.length > 0 && (
                  <div>
                    <div className="text-muted-foreground/70 mb-4 text-[10px] font-semibold uppercase tracking-widest">
                      Data included
                    </div>
                    <div className="space-y-3">
                      {features.map((feature) => {
                        const Icon = FEATURE_ICONS[feature.featureId]
                        return (
                          <div
                            key={feature.featureId}
                            className="flex items-center justify-between text-sm group/feature"
                          >
                            <div className="text-muted-foreground flex items-center gap-3 transition-colors group-hover/feature:text-foreground">
                              {Icon && <Icon className="size-4 opacity-70" />}
                              <span className="font-medium">{feature.label}</span>
                            </div>
                            <div className="text-right">
                              <span className="font-semibold tabular-nums text-foreground">
                                {feature.value}
                              </span>
                              {feature.detail && (
                                <p className="text-muted-foreground/70 text-[10px] mt-0.5 font-medium">
                                  {feature.detail}
                                </p>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                <Separator className="bg-border/60" />

                <div>
                  <div className="text-muted-foreground/70 mb-4 text-[10px] font-semibold uppercase tracking-widest">
                    Platform features
                  </div>
                  <div className="space-y-3">
                    {planFeatures.map((feature) => (
                      <div
                        key={feature.label}
                        className="flex items-start gap-3 text-sm"
                      >
                        <CircleCheckIcon className="text-primary size-4 shrink-0 mt-0.5" />
                        <span className="text-muted-foreground leading-snug">
                          {feature.label}
                        </span>
                        {feature.value && (
                          <span className="font-semibold tabular-nums text-xs ml-auto shrink-0">
                            {feature.value}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>

              <CardFooter className="mt-auto pt-4 pb-6 px-6">
                <Button
                  variant={btn.variant}
                  disabled={btn.disabled || loadingProductId === product.id}
                  className={cn(
                    "w-full h-10 transition-all",
                    isUpgrade && "shadow-md hover:shadow-lg font-medium",
                    !isUpgrade && "font-medium"
                  )}
                  onClick={() =>
                    handleCheckout(product.id, product.display?.button_url)
                  }
                >
                  {loadingProductId === product.id ? (
                    <Spinner className="size-4" />
                  ) : (
                    <>
                      {btn.label}
                      {trialAvailable && !btn.disabled && ` — Start ${product.free_trial?.length}-day free trial`}
                    </>
                  )}
                </Button>
              </CardFooter>
            </Card>
          )
        })}
      </div>

      {/* Enterprise Full Width Plan */}
      <Card className="flex flex-col overflow-hidden border-border/50 bg-primary/[0.02] shadow-sm mt-8 transition-colors hover:border-border">
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between p-8 pb-6">
          <div className="max-w-xl">
            <CardTitle className="text-[11px] font-semibold uppercase tracking-widest text-primary mb-3">
              Enterprise
            </CardTitle>
            <div className="flex items-baseline gap-1 mb-2">
              <span className="text-4xl font-semibold tracking-tight">Custom</span>
            </div>
            <CardDescription className="text-[13px] leading-relaxed text-muted-foreground/90">
              Built for high-volume teams with custom compliance, data retention, and dedicated support requirements.
            </CardDescription>
          </div>
          <Button variant="default" className="w-full sm:w-auto shrink-0 h-10 shadow-sm" onClick={handleEnterpriseContact}>
            Contact Sales
          </Button>
        </CardHeader>

        <Separator className="bg-border/40" />

        <div className="p-8 pt-6 flex flex-col sm:flex-row gap-12">
          <div className="flex-1">
            <div className="text-muted-foreground/70 mb-5 text-[10px] font-semibold uppercase tracking-widest">
              Data included
            </div>
            <div className="space-y-4">
              {ENTERPRISE_DATA_FEATURES.map((feature) => {
                const Icon = FEATURE_ICONS[feature.featureId]
                return (
                  <div
                    key={feature.featureId}
                    className="flex items-center justify-between gap-4 text-[13px] border-b border-border/30 pb-3 last:border-0 last:pb-0 group/feature"
                  >
                    <div className="text-muted-foreground flex items-center gap-3 transition-colors group-hover/feature:text-foreground">
                      {Icon && <Icon className="size-4 opacity-70" />}
                      <span className="font-medium">{feature.label}</span>
                    </div>
                    <span className="font-semibold tabular-nums text-foreground">
                      {feature.value}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Hairline border for high-DPI displays via CSS var */}
          <div className="hidden sm:block w-[var(--border-hairline,1px)] bg-border/40" />

          <div className="flex-1">
            <div className="text-muted-foreground/70 mb-5 text-[10px] font-semibold uppercase tracking-widest">
              Platform features
            </div>
            <div className="space-y-4">
              {enterprisePlanFeatures.map((feature) => (
                <div
                  key={feature.label}
                  className="flex items-start gap-3 text-[13px]"
                >
                  <CircleCheckIcon className="text-primary size-[18px] shrink-0 mt-[2px]" />
                  <span className="text-muted-foreground leading-snug">
                    {feature.label}
                  </span>
                  {feature.value && (
                    <span className="font-semibold tabular-nums ml-auto shrink-0">
                      {feature.value}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>

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
    </div>
  )
}
