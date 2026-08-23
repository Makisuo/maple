import { describe, expect, it } from "vitest"
import {
	TAX_ID_TYPES,
	TAX_ID_TYPE_VALUES,
	defaultTaxIdTypeFor,
	taxIdExampleFor,
	taxIdLabel,
} from "./billing-tax-ids"

describe("tax-id catalog", () => {
	it("describes every accepted type exactly once", () => {
		const described = TAX_ID_TYPES.map((info) => info.type)
		expect(new Set(described).size).toBe(described.length)
		expect([...described].sort()).toEqual([...TAX_ID_TYPE_VALUES].sort())
	})

	it("preselects the shared EU VAT type for EU members and the country's own type elsewhere", () => {
		expect(defaultTaxIdTypeFor("DE")).toBe("eu_vat")
		expect(defaultTaxIdTypeFor("fr")).toBe("eu_vat")
		expect(defaultTaxIdTypeFor("GB")).toBe("gb_vat")
		expect(defaultTaxIdTypeFor("CH")).toBe("ch_vat")
		expect(defaultTaxIdTypeFor("US")).toBe("us_ein")
		expect(defaultTaxIdTypeFor("AQ")).toBeUndefined()
		expect(defaultTaxIdTypeFor(null)).toBeUndefined()
	})

	it("shows the country-specific EU VAT example and falls back to the type's own", () => {
		expect(taxIdExampleFor("eu_vat", "NL")).toBe("NL123456789B12")
		expect(taxIdExampleFor("eu_vat", "US")).toBe("DE123456789")
		expect(taxIdExampleFor("gb_vat")).toBe("GB123456789")
		expect(taxIdExampleFor("nope")).toBe("")
	})

	it("labels unknown upstream types by their raw value", () => {
		expect(taxIdLabel("eu_vat")).toBe("EU VAT number")
		expect(taxIdLabel("xx_new")).toBe("xx_new")
	})
})
