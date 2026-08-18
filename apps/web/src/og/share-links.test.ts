import { describe, expect, it } from "vitest"
import {
	alertChartIdFromPath,
	escapeAttribute,
	ogIdFromPath,
	ogMetaAdditions,
	ogMetaReplacements,
	shareTokenFromPath,
} from "./share-links"

const meta = {
	title: "Checkout health",
	description: "Shared dashboard · 6 widgets",
	imagePath: "/share/og/abc.def.png",
}

describe("shareTokenFromPath", () => {
	it("reads the token out of a share path", () => {
		expect(shareTokenFromPath("/share/mshare_abc123")).toBe("mshare_abc123")
	})

	it("stops at the first segment, so a suffixed path cannot smuggle one in", () => {
		expect(shareTokenFromPath("/share/mshare_abc123/extra")).toBe("mshare_abc123")
	})

	it("never treats an image id as a token", () => {
		expect(shareTokenFromPath("/share/og/abc.def.png")).toBeUndefined()
	})

	it("ignores everything that is not a share link", () => {
		expect(shareTokenFromPath("/dashboards/d1")).toBeUndefined()
		expect(shareTokenFromPath("/share/")).toBeUndefined()
		expect(shareTokenFromPath("/")).toBeUndefined()
	})
})

describe("ogIdFromPath", () => {
	it("reads the image id", () => {
		expect(ogIdFromPath("/share/og/abc.def.png")).toBe("abc.def")
	})

	it("requires the .png suffix and a single segment", () => {
		expect(ogIdFromPath("/share/og/abc.def")).toBeUndefined()
		expect(ogIdFromPath("/share/og/nested/abc.def.png")).toBeUndefined()
		expect(ogIdFromPath("/share/og/.png")).toBeUndefined()
		expect(ogIdFromPath("/share/mshare_abc123")).toBeUndefined()
	})
})

describe("ogMetaReplacements", () => {
	it("makes the image URL absolute against the page's own origin", () => {
		expect(ogMetaReplacements(meta, "https://app.maple.dev").get("og:image")).toBe(
			"https://app.maple.dev/share/og/abc.def.png",
		)
	})

	it("covers both the OpenGraph and Twitter tag names", () => {
		const replacements = ogMetaReplacements(meta, "https://app.maple.dev")

		expect(replacements.get("og:title")).toBe(meta.title)
		expect(replacements.get("twitter:title")).toBe(meta.title)
		expect(replacements.get("og:description")).toBe(meta.description)
		expect(replacements.get("twitter:description")).toBe(meta.description)
		expect(replacements.get("twitter:image")).toBe(replacements.get("og:image"))
	})
})

describe("ogMetaAdditions", () => {
	it("advertises the size the card is actually rendered at", () => {
		expect(ogMetaAdditions(meta)).toContain('content="1200"')
		expect(ogMetaAdditions(meta)).toContain('content="630"')
	})

	it("escapes a board name that would otherwise close the attribute", () => {
		const additions = ogMetaAdditions({ ...meta, title: `Checkout" /><script>alert(1)</script>` })

		expect(additions).not.toContain("<script>")
		expect(additions).toContain("&quot;")
	})
})

describe("escapeAttribute", () => {
	it("escapes ampersands before the entities it introduces", () => {
		expect(escapeAttribute(`a & "b" <c>`)).toBe("a &amp; &quot;b&quot; &lt;c&gt;")
	})
})

describe("alertChartIdFromPath", () => {
	// A signed chart id is base64url + "." + signature, so unlike a share OG id
	// it legitimately contains a dot. Only the trailing `.png` is the extension.
	const ID = "eyJhIjoxfQ.s1gn4tur3"

	it("reads the id out of the image path", () => {
		expect(alertChartIdFromPath(`/alerts/chart/${ID}.png`)).toBe(ID)
	})

	it("ignores the SPA's own alert routes", () => {
		// `/alerts` is a real page. Matching it here would answer a navigation
		// with a PNG.
		expect(alertChartIdFromPath("/alerts")).toBeUndefined()
		expect(alertChartIdFromPath("/alerts/rule_1")).toBeUndefined()
		expect(alertChartIdFromPath("/alerts/chart/")).toBeUndefined()
	})

	it("rejects an id carrying path structure", () => {
		expect(alertChartIdFromPath(`/alerts/chart/../${ID}.png`)).toBeUndefined()
		expect(alertChartIdFromPath("/alerts/chart/a/b.png")).toBeUndefined()
	})

	it("requires the .png extension", () => {
		expect(alertChartIdFromPath(`/alerts/chart/${ID}`)).toBeUndefined()
		expect(alertChartIdFromPath(`/alerts/chart/${ID}.jpg`)).toBeUndefined()
	})

	it("does not collide with the share image path", () => {
		expect(alertChartIdFromPath("/share/og/abc.png")).toBeUndefined()
		expect(ogIdFromPath(`/alerts/chart/${ID}.png`)).toBeUndefined()
	})
})
