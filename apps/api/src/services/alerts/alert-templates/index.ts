import { PLANETSCALE_ALERT_TEMPLATES } from "./planetscale"
import type { AlertTemplateDefinition } from "./types"

export type { AlertTemplateDefinition } from "./types"

/**
 * Every ready-made alert rule Maple can offer.
 *
 * One flat registry rather than per-integration lookups: the alerts UI lists
 * them together, and a template's `requirement` is what decides whether it is
 * offered, not which file it lives in.
 */
export const ALERT_TEMPLATES: ReadonlyArray<AlertTemplateDefinition> = [...PLANETSCALE_ALERT_TEMPLATES]

export const getAlertTemplate = (id: string): AlertTemplateDefinition | undefined =>
	ALERT_TEMPLATES.find((template) => template.id === id)
