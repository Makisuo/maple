import { describe, expect, it } from "vitest"
import { CLOUDFLARE_IPV4_RANGES, CLOUDFLARE_IPV6_RANGES } from "./cloudflare-ips.ts"

const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/
const IPV6_CIDR = /^[0-9a-f:]+\/\d{1,3}$/

describe("Cloudflare proxy ranges", () => {
	it("has a non-empty, well-formed IPv4 allow-list", () => {
		expect(CLOUDFLARE_IPV4_RANGES.length).toBeGreaterThan(5)
		for (const cidr of CLOUDFLARE_IPV4_RANGES) {
			const match = cidr.match(IPV4_CIDR)
			expect(match, cidr).not.toBeNull()
			const octets = match!.slice(1, 5).map(Number)
			for (const octet of octets) expect(octet).toBeLessThanOrEqual(255)
			expect(Number(match![5])).toBeLessThanOrEqual(32)
		}
	})

	it("has a non-empty, well-formed IPv6 allow-list", () => {
		expect(CLOUDFLARE_IPV6_RANGES.length).toBeGreaterThan(3)
		for (const cidr of CLOUDFLARE_IPV6_RANGES) {
			expect(cidr, cidr).toMatch(IPV6_CIDR)
			expect(Number(cidr.split("/")[1])).toBeLessThanOrEqual(128)
		}
	})

	it("never contains the open-internet range", () => {
		expect(CLOUDFLARE_IPV4_RANGES).not.toContain("0.0.0.0/0")
		expect(CLOUDFLARE_IPV6_RANGES).not.toContain("::/0")
	})
})
