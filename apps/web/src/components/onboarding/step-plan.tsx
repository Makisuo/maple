import { useEffect } from "react"
import { motion } from "motion/react"
import { useCustomer } from "autumn-js/react"
import { hasSelectedPlan } from "@/lib/billing/plan-gating"
import { PricingCards } from "@/components/settings/pricing-cards"
import { PulseIcon } from "@/components/icons"

export function StepPlan({
  isComplete,
  onComplete,
}: {
  isComplete: boolean
  onComplete: () => void
}) {
  const { data: customer, isLoading } = useCustomer()
  const selectedPlan = hasSelectedPlan(customer)

  useEffect(() => {
    if (selectedPlan && !isComplete) {
      onComplete()
    }
  }, [selectedPlan, isComplete, onComplete])

  return (
    <div className="flex-1 flex flex-col items-center px-6 py-12 overflow-auto">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="w-full max-w-5xl"
      >
        {/* Heading */}
        <div className="text-center mb-10">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-primary">
            Almost there
          </span>
          <h2 className="text-3xl font-semibold tracking-tight mt-2">
            Start your free trial
          </h2>
          <p className="text-muted-foreground text-[15px] mt-3 max-w-lg mx-auto">
            Try any plan free for 30 days. No credit card required. Downgrade
            anytime.
          </p>
        </div>

        {/* Pricing Cards */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <PulseIcon className="animate-spin text-muted-foreground" size={24} />
          </div>
        ) : (
          <PricingCards />
        )}
      </motion.div>
    </div>
  )
}
