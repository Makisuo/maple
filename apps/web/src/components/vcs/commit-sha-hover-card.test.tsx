// @vitest-environment jsdom

import { describe, expect, it } from "vitest"

import { commitQueryAtom } from "./commit-sha-hover-card"

// `commitQueryAtom` is an `Atom.family` keyed by the SHA string. The whole point is
// that the prefetch subscriber, the popup body, the deploy markers, and the commit
// list rows all resolve to ONE shared atom per SHA (one in-flight fetch + one cached
// result) instead of each minting a fresh atom that refetches. These guard that
// contract: same SHA → identical atom, different SHA → distinct atom. The previous
// implementation (a plain `(sha) => MapleApiAtomClient.query(...)`) failed the first
// assertion because every call built a new request object → a new atom.
describe("commitQueryAtom", () => {
	const SHA_A = "a".repeat(40)
	const SHA_B = "b".repeat(40)

	it("returns the same atom instance for the same SHA", () => {
		expect(commitQueryAtom(SHA_A)).toBe(commitQueryAtom(SHA_A))
	})

	it("returns distinct atom instances for distinct SHAs", () => {
		expect(commitQueryAtom(SHA_A)).not.toBe(commitQueryAtom(SHA_B))
	})
})
