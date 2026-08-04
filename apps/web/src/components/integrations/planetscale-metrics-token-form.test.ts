import { describe, expect, it } from "vitest"

import { normalizeTokenPaste } from "./planetscale-metrics-token-form"

const empty = { id: "", secret: "" }

describe("normalizeTokenPaste", () => {
	it("splits the id:secret line PlanetScale hands out", () => {
		expect(normalizeTokenPaste("id", "tok_abc:pscale_tkn_xyz", empty)).toEqual({
			id: "tok_abc",
			secret: "pscale_tkn_xyz",
		})
	})

	it("splits regardless of which field received the paste", () => {
		expect(normalizeTokenPaste("secret", "tok_abc:pscale_tkn_xyz", empty)).toEqual({
			id: "tok_abc",
			secret: "pscale_tkn_xyz",
		})
	})

	it("routes a bare secret pasted into the id field to the secret field", () => {
		expect(normalizeTokenPaste("id", "pscale_tkn_xyz", { id: "tok_abc", secret: "" })).toEqual({
			id: "tok_abc",
			secret: "pscale_tkn_xyz",
		})
	})

	it("keeps a plain id in the id field", () => {
		expect(normalizeTokenPaste("id", "tok_abc", empty)).toEqual({ id: "tok_abc", secret: "" })
	})

	it("trims surrounding whitespace from a copied line", () => {
		expect(normalizeTokenPaste("id", "  tok_abc : pscale_tkn_xyz \n", empty)).toEqual({
			id: "tok_abc",
			secret: "pscale_tkn_xyz",
		})
	})

	it("leaves the fields untouched on an empty paste", () => {
		const current = { id: "tok_abc", secret: "pscale_tkn_xyz" }
		expect(normalizeTokenPaste("secret", "   ", current)).toEqual(current)
	})

	it("does not split on a colon that has nothing after it", () => {
		expect(normalizeTokenPaste("id", "tok_abc:", empty)).toEqual({ id: "tok_abc:", secret: "" })
	})

	it("keeps only the first colon as the separator", () => {
		// Secrets are opaque; a colon inside one must not truncate it.
		expect(normalizeTokenPaste("id", "tok_abc:pscale_tkn_a:b", empty)).toEqual({
			id: "tok_abc",
			secret: "pscale_tkn_a:b",
		})
	})
})
