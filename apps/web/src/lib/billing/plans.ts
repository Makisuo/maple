export interface PlanLimits {
  logsKB: number
  tracesKB: number
  metricsKB: number
  retentionDays: number
}

export const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: { logsKB: 10_000_000, tracesKB: 10_000_000, metricsKB: 10_000_000, retentionDays: 7 },
  startup: { logsKB: 40_000_000, tracesKB: 40_000_000, metricsKB: 40_000_000, retentionDays: 30 },
}

const DEFAULT_PLAN = "free"

export function getPlanLimits(planSlug: string | undefined): PlanLimits {
  return PLAN_LIMITS[planSlug ?? DEFAULT_PLAN] ?? PLAN_LIMITS[DEFAULT_PLAN]
}

export interface PlanFeature {
  icon: string
  label: string
  value: string
}

export const PLAN_FEATURES: Record<string, PlanFeature[]> = {
  starter: [
    { icon: "clock", label: "Data retention", value: "14 days" },
    { icon: "grid", label: "Dashboards", value: "Unlimited" },
    { icon: "bell", label: "Alerting", value: "Advanced" },
    { icon: "code", label: "API access", value: "Full" },
    { icon: "shield", label: "Support", value: "Email" },
  ],
  startup: [
    { icon: "clock", label: "Data retention", value: "30 days" },
    { icon: "grid", label: "Dashboards", value: "Unlimited" },
    { icon: "bell", label: "Alerting", value: "Advanced" },
    { icon: "code", label: "API access", value: "Full" },
    { icon: "shield", label: "Support", value: "Private Channel" },
  ],
  enterprise: [
    { icon: "clock", label: "Data retention", value: "Custom" },
    { icon: "grid", label: "Dashboards", value: "Unlimited" },
    { icon: "bell", label: "Alerting", value: "Enterprise" },
    { icon: "code", label: "API access", value: "Full" },
    { icon: "shield", label: "Support", value: "Priority" },
  ],
}

export function getPlanFeatures(planSlug: string | undefined): PlanFeature[] {
  return PLAN_FEATURES[planSlug ?? DEFAULT_PLAN] ?? PLAN_FEATURES[DEFAULT_PLAN]
}
