import { useAuth } from "@clerk/clerk-react"
import { useCustomer } from "autumn-js/react"
import { Navigate, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"
import { RocketIcon } from "@/components/icons"
import { PricingCards } from "@/components/settings/pricing-cards"
import { hasSelectedPlan } from "@/lib/billing/plan-gating"
import { parseRedirectUrl } from "@/lib/redirect-utils"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"

const SelectPlanSearch = Schema.Struct({
  redirect_url: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/select-plan")({
  component: SelectPlanPage,
  validateSearch: Schema.standardSchemaV1(SelectPlanSearch),
})

function resolveRedirectTarget(target: string | undefined): string {
  if (!target) return "/"
  return target.startsWith("/") ? target : "/"
}

function SelectPlanPage() {
  if (!isClerkAuthEnabled) {
    return <Navigate to="/" replace />
  }

  const { isLoaded, isSignedIn, orgId } = useAuth()
  const { customer, isLoading: isCustomerLoading } = useCustomer()
  const { redirect_url } = Route.useSearch()

  if (!isLoaded || isCustomerLoading) {
    return null
  }

  const redirectTarget = resolveRedirectTarget(redirect_url)

  if (!isSignedIn) {
    return <Navigate to="/sign-in" search={{ redirect_url: redirectTarget }} replace />
  }

  if (!orgId) {
    return <Navigate to="/org-required" search={{ redirect_url: redirectTarget }} replace />
  }

  if (hasSelectedPlan(customer)) {
    const target = parseRedirectUrl(redirectTarget)
    return <Navigate to={target.pathname} search={target.search} replace />
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-background flex flex-col items-center justify-center py-12">
      {/* Premium Background Grid / Glow */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center [mask-image:radial-gradient(ellipse_at_center,transparent_20%,black)]">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]" />
      </div>
      
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute top-[20%] left-[50%] -translate-x-1/2 -translate-y-1/2 h-[40rem] w-[40rem] rounded-full bg-primary/5 blur-[100px]" />
      </div>

      <section className="relative mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 md:px-8 z-10">
        <div className="text-center flex flex-col items-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-[11px] font-medium tracking-wider text-primary uppercase mb-6">
            <RocketIcon size={14} />
            30-day free trial
          </div>
          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-foreground [text-wrap:balance]">
            Start your free trial
          </h1>
          <p className="text-muted-foreground mt-4 text-sm md:text-base leading-relaxed max-w-lg mx-auto [text-wrap:balance]">
            Try any paid plan free for 30 days. You won't be charged until the trial ends. Cancel anytime.
          </p>
        </div>

        <div className="mt-4">
          <PricingCards />
        </div>
      </section>
    </main>
  )
}
