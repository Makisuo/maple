import type { InvestigationHttpError } from "./investigations"
import { defineHttpErrorPolicies } from "./error-policy"

export type InvestigationErrorTag = InvestigationHttpError["_tag"]

/** One recovery/presentation policy per semantic investigation failure. */
export const investigationErrorPolicy = defineHttpErrorPolicies<InvestigationErrorTag>()({
	"@maple/http/investigations/InvestigationPersistenceError": {
		title: "Investigations are temporarily unavailable",
		retry: "backoff",
		recovery: "retry",
		origin: "dependency",
		exposure: "redacted",
	},
	"@maple/http/investigations/InvestigationValidationError": {
		title: "Invalid investigation",
		retry: "never",
		recovery: "fix_request",
		origin: "client",
		exposure: "public_message",
	},
	"@maple/http/investigations/InvestigationNotFoundError": {
		title: "Investigation not found",
		retry: "never",
		recovery: "none",
		origin: "client",
		exposure: "public_message",
	},
	"@maple/http/investigations/InvestigationQuotaError": {
		title: "Investigation limit reached",
		retry: "after",
		recovery: "retry",
		origin: "client",
		exposure: "public_message",
	},
	"@maple/http/investigations/InvestigationAutomationDisabledError": {
		title: "Automatic investigations are disabled",
		retry: "never",
		recovery: "none",
		origin: "client",
		exposure: "public_message",
	},
	"@maple/http/investigations/InvestigationAgentUnavailableError": {
		title: "Investigation agent is temporarily unavailable",
		retry: "backoff",
		recovery: "retry",
		origin: "dependency",
		exposure: "public_message",
	},
	"@maple/http/investigations/InvestigationStartFailedError": {
		title: "Investigation could not be started",
		retry: "backoff",
		recovery: "retry",
		origin: "dependency",
		exposure: "public_message",
	},
	"@maple/http/investigations/InvestigationRejectedError": {
		title: "Investigation agent rejected the request",
		retry: "never",
		recovery: "reconnect",
		origin: "dependency",
		exposure: "redacted",
	},
})

export const isInvestigationErrorTag = (tag: string): tag is InvestigationErrorTag =>
	Object.hasOwn(investigationErrorPolicy, tag)
