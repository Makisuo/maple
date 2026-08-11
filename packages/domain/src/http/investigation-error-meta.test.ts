import { describe, expect, it } from "@effect/vitest"
import { investigationErrorPolicy } from "./investigation-error-meta"
import { investigationHttpErrors } from "./investigations"

const tagOf = (errorClass: (typeof investigationHttpErrors)[number]): string => {
	const fields = errorClass.fields as Record<string, unknown>
	const tagField = fields._tag as { readonly schema?: { readonly literal?: unknown } } | undefined
	const tag = tagField?.schema?.literal
	if (typeof tag !== "string") throw new Error("investigation error class has no literal _tag")
	return tag
}

describe("investigation error policy", () => {
	it("covers every semantic error tag exactly once", () => {
		const tags = investigationHttpErrors.map(tagOf)
		expect(new Set(tags).size).toBe(tags.length)
		expect(Object.keys(investigationErrorPolicy).sort()).toEqual([...tags].sort())
	})

	it("separates terminal configuration from transient start failures", () => {
		expect(
			investigationErrorPolicy["@maple/http/investigations/InvestigationAutomationDisabledError"].retry,
		).toBe("never")
		expect(
			investigationErrorPolicy["@maple/http/investigations/InvestigationAgentUnavailableError"].retry,
		).toBe("backoff")
		expect(investigationErrorPolicy["@maple/http/investigations/InvestigationQuotaError"].retry).toBe(
			"after",
		)
	})
})
