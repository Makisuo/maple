import { describe, expect, it } from "vitest"
import {
	hasCustomTemplate,
	renderTemplate,
	resolveTemplate,
	type NotificationTemplateConfig,
	type TemplateContext,
} from "./renderer"

const ctx: TemplateContext = {
	"rule.name": "Checkout errors",
	severity: "critical",
	"observed.summary": "8% > 5%",
	group: "all",
	window: "5m",
}

describe("renderTemplate", () => {
	it("substitutes known variables", () => {
		const { text, missing } = renderTemplate("{{ rule.name }} is {{ severity }}", ctx)
		expect(text).toBe("Checkout errors is critical")
		expect(missing).toEqual([])
	})

	it("renders missing variables as empty string and reports them", () => {
		const { text, missing } = renderTemplate("a={{ unknown.key }}b", ctx)
		expect(text).toBe("a=b")
		expect(missing).toEqual(["unknown.key"])
	})

	it("dedups and sorts the missing list", () => {
		const { missing } = renderTemplate("{{ b }}{{ a }}{{ b }}", ctx)
		expect(missing).toEqual(["a", "b"])
	})

	it("honors the default: filter when a variable is missing or empty", () => {
		expect(renderTemplate('{{ unknown | default:"n/a" }}', ctx).text).toBe("n/a")
		expect(renderTemplate('{{ rule.name | default:"n/a" }}', ctx).text).toBe("Checkout errors")
		// a default does NOT count as missing
		expect(renderTemplate('{{ unknown | default:"x" }}', ctx).missing).toEqual([])
	})

	it("keeps #if blocks when the key is present, drops them otherwise", () => {
		const tpl = "{{#if group}}group={{ group }}{{/if}}{{#if absent}}never{{/if}}"
		expect(renderTemplate(tpl, ctx).text).toBe("group=all")
	})

	it("treats an empty-string value as absent for #if", () => {
		expect(renderTemplate("{{#if blank}}x{{/if}}", { blank: "" }).text).toBe("")
	})

	it("never throws on a malformed template — leaves it as literal text", () => {
		const broken = "hello {{ rule.name "
		expect(() => renderTemplate(broken, ctx)).not.toThrow()
		expect(renderTemplate(broken, ctx).text).toBe("hello {{ rule.name ")
	})

	it("tolerates whitespace inside the braces", () => {
		expect(renderTemplate("{{rule.name}} {{   severity   }}", ctx).text).toBe("Checkout errors critical")
	})
})

describe("resolveTemplate", () => {
	const config: NotificationTemplateConfig = {
		title: "top title",
		body: "top body",
		overrides: { slack: { body: "slack body" } },
	}

	it("returns nulls for a null config", () => {
		expect(resolveTemplate(null, "slack")).toEqual({ title: null, body: null })
	})

	it("applies per-destination override over the top-level field", () => {
		expect(resolveTemplate(config, "slack")).toEqual({ title: "top title", body: "slack body" })
	})

	it("falls back to the top-level field when no override for that destination", () => {
		expect(resolveTemplate(config, "discord")).toEqual({ title: "top title", body: "top body" })
	})

	it("uses a legacy override alias after the current destination key", () => {
		expect(resolveTemplate(config, "slack-bot", ["slack"])).toEqual({
			title: "top title",
			body: "slack body",
		})
		expect(
			resolveTemplate(
				{
					...config,
					overrides: {
						slack: { body: "legacy body" },
						"slack-bot": { body: "current body" },
					},
				},
				"slack-bot",
				["slack"],
			),
		).toEqual({ title: "top title", body: "current body" })
	})

	it("treats blank strings as unset (→ null, i.e. built-in default)", () => {
		expect(resolveTemplate({ title: "   ", body: "" }, "slack")).toEqual({
			title: null,
			body: null,
		})
	})
})

describe("hasCustomTemplate", () => {
	it("is false only when both fields are null", () => {
		expect(hasCustomTemplate({ title: null, body: null })).toBe(false)
		expect(hasCustomTemplate({ title: "t", body: null })).toBe(true)
		expect(hasCustomTemplate({ title: null, body: "b" })).toBe(true)
	})
})
