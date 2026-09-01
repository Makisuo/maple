// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import { MetaLine } from "./meta-line"

/**
 * The bug these pin: every infra table used to render a LEADING separator per
 * item, so an absent first item left a dot with nothing before it, and a wrap
 * left a dot with nothing after it.
 */
describe("MetaLine", () => {
	afterEach(cleanup)

	const separators = (container: HTMLElement) =>
		[...container.querySelectorAll("span")].filter((el) => el.textContent === "·").length

	it("puts one separator between two items and none at the edges", () => {
		const { container } = render(<MetaLine items={["ns default", "node ip-10-0-1-1"]} />)
		expect(separators(container)).toBe(1)
		expect(container.textContent).toBe("ns default·node ip-10-0-1-1")
	})

	it("renders no separator for a single item", () => {
		const { container } = render(<MetaLine items={["kind deployment"]} />)
		expect(separators(container)).toBe(0)
	})

	it("does not leave a leading separator when an earlier item is absent", () => {
		// The workload table's exact shape: namespace optional, kind always present.
		const { container } = render(<MetaLine items={[undefined, "kind deployment"]} />)
		expect(separators(container)).toBe(0)
		expect(container.textContent).toBe("kind deployment")
	})

	// `value && \`ns ${value}\`` yields "" for an empty value, not false — which
	// is how the hosts table came to render "linux · ·".
	it("treats the empty string as absent", () => {
		const { container } = render(<MetaLine items={["linux", "", ""]} />)
		expect(separators(container)).toBe(0)
		expect(container.textContent).toBe("linux")
	})

	it("drops false and null items without leaving a gap", () => {
		const { container } = render(<MetaLine items={["a", false, null, undefined, "", "b"]} />)
		expect(separators(container)).toBe(1)
		expect(container.textContent).toBe("a·b")
	})

	it("renders nothing at all when every item is absent", () => {
		const { container } = render(<MetaLine items={[null, undefined, false]} />)
		expect(container.firstChild).toBeNull()
	})

	it("keeps the untruncated text reachable through the title", () => {
		render(<MetaLine items={["ns default", "node long-name"]} title="ns default · node long-name" />)
		expect(screen.getByTitle("ns default · node long-name")).toBeTruthy()
	})

	it("stays on one line", () => {
		// `flex-wrap` is what let a long node name turn a table row into three
		// lines and knock the numeric columns out of alignment.
		const { container } = render(<MetaLine items={["a", "b"]} />)
		const line = container.firstElementChild
		expect(line?.className).toContain("truncate")
		expect(line?.className).not.toContain("flex-wrap")
	})
})
