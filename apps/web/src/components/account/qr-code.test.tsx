// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { QrCode } from "./qr-code"

const TOTP_URI = "otpauth://totp/Maple:ada@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Maple"

describe("QrCode", () => {
	afterEach(cleanup)

	it("encodes a value into a single square path", () => {
		const { container } = render(<QrCode value={TOTP_URI} />)
		const svg = container.querySelector("svg")
		const path = container.querySelector("path")

		expect(path?.getAttribute("d")).toBeTruthy()
		expect(path?.getAttribute("fill")).toBe("currentColor")

		// A QR matrix is square, and the viewBox must match its module count or the code is
		// unscannable — a cropped or letterboxed matrix still renders, it just cannot be read.
		const viewBox = svg?.getAttribute("viewBox")?.split(" ") ?? []
		expect(viewBox[0]).toBe("0")
		expect(viewBox[1]).toBe("0")
		expect(viewBox[2]).toBe(viewBox[3])
		expect(Number(viewBox[2])).toBeGreaterThan(20)
	})

	it("produces a different path for a different value", () => {
		const first = render(<QrCode value={TOTP_URI} />)
		const a = first.container.querySelector("path")?.getAttribute("d")
		cleanup()
		const second = render(<QrCode value={`${TOTP_URI}&digits=6`} />)
		const b = second.container.querySelector("path")?.getAttribute("d")

		expect(a).not.toBe(b)
	})
})
