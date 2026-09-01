// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { REPLAY_BLOCK_CLASS } from "@/components/common/replay-privacy"
import { ConnectInstructions } from "./guided-setup"

const API_KEY = "mpl_ingest_supersecretkey123"

describe("ConnectInstructions", () => {
	afterEach(cleanup)

	it("keeps the ingest key out of session replay", () => {
		const { container } = render(
			<ConnectInstructions framework="nodejs" apiKey={API_KEY} showCredentials />,
		)

		fireEvent.click(screen.getByRole("tab", { name: "Instrument" }))
		fireEvent.click(screen.getByRole("tab", { name: "Claude Code" }))

		// rrweb blocks an `rr-block` element with its whole subtree, so every plain-text
		// rendering of the key must sit under one. The credentials column renders into a
		// readonly <input>, which `maskAllInputs: true` already masks.
		const blocked = [...container.querySelectorAll(`.${REPLAY_BLOCK_CLASS}`)]
		expect(blocked.length).toBeGreaterThan(0)
		for (const el of container.querySelectorAll("pre")) {
			if (!el.textContent?.includes(API_KEY)) continue
			expect(blocked.some((b) => b.contains(el))).toBe(true)
		}
		const leaked = [...container.querySelectorAll("*")].filter(
			(el) =>
				el.children.length === 0 &&
				el.textContent?.includes(API_KEY) &&
				!blocked.some((b) => b.contains(el)),
		)
		expect(leaked).toEqual([])
	})
})
