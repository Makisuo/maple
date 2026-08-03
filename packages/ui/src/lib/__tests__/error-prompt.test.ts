import { describe, expect, it } from "vitest"

import { formatErrorPrompt } from "../error-prompt"

describe("formatErrorPrompt", () => {
	it("renders a span-shaped prompt with operation and relevant context", () => {
		const prompt = formatErrorPrompt({
			message: "connection refused",
			serviceName: "checkout",
			operation: "GET /cart",
			attributes: {
				"http.method": "GET",
				"http.route": "/cart",
				"http.status_code": "503",
				"irrelevant.key": "dropped",
			},
		})

		expect(prompt).toMatchInlineSnapshot(`
			"I'm debugging an error in my distributed system. Please help me understand and fix this issue.

			**Service:** checkout
			**Operation:** GET /cart

			**Error:**
			\`\`\`
			connection refused
			\`\`\`

			**Context:**
			- http.method: GET
			- http.route: /cart
			- http.status_code: 503

			What could be causing this error and how can I fix it?"
		`)
	})

	it("omits the operation line and context block for a bare log error", () => {
		const prompt = formatErrorPrompt({ message: "boom", serviceName: "worker" })
		expect(prompt).not.toContain("**Operation:**")
		expect(prompt).not.toContain("**Context:**")
		expect(prompt).toContain("**Service:** worker")
	})
})
