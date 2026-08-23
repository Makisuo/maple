import { describe, expect, it } from "vitest"
import { extractIssueIdsFromText, parsePullRequestUrl } from "./pull-request-ref"

const APP = "https://app.maple.dev"
const ISSUE = "3f1c8a2e-9b4d-4f7a-8c1e-2d5b6a7c8e90"
const OTHER_ISSUE = "aa11bb22-cc33-dd44-ee55-ff6677889900"

describe("parsePullRequestUrl", () => {
	it("parses a canonical GitHub pull request URL", () => {
		expect(parsePullRequestUrl("https://github.com/MapleTechLabs/maple/pull/612")).toEqual({
			provider: "github",
			owner: "MapleTechLabs",
			repo: "maple",
			repoFullName: "MapleTechLabs/maple",
			number: 612,
			url: "https://github.com/MapleTechLabs/maple/pull/612",
		})
	})

	it("normalizes review-tab and fragment suffixes to the PR itself", () => {
		const expected = "https://github.com/o/r/pull/7"
		for (const input of [
			"https://github.com/o/r/pull/7/files",
			"https://github.com/o/r/pull/7/commits/abc123",
			"https://github.com/o/r/pull/7#discussion_r123456",
			"https://github.com/o/r/pull/7?w=1",
			"https://www.github.com/o/r/pull/7",
			"  https://github.com/o/r/pull/7  ",
		]) {
			expect(parsePullRequestUrl(input)?.url, input).toBe(expected)
		}
	})

	it("strips a .git suffix picked up from a clone remote", () => {
		const parsed = parsePullRequestUrl("https://github.com/o/r.git/pull/9")
		expect(parsed?.repo).toBe("r")
		expect(parsed?.repoFullName).toBe("o/r")
	})

	it("rejects anything that is not a GitHub pull request URL", () => {
		for (const input of [
			"",
			"   ",
			"not a url",
			"https://github.com/o/r",
			"https://github.com/o/r/issues/7",
			"https://github.com/o/r/pull/",
			"https://github.com/o/r/pull/abc",
			"https://gitlab.com/o/r/pull/7",
			"https://github.example.com/o/r/pull/7",
			"https://evil.com/github.com/o/r/pull/7",
			"ftp://github.com/o/r/pull/7",
			"javascript:alert(1)",
		]) {
			expect(parsePullRequestUrl(input), input).toBeNull()
		}
	})

	it("rejects PR numbers that are zero or beyond safe-integer precision", () => {
		expect(parsePullRequestUrl("https://github.com/o/r/pull/0")).toBeNull()
		expect(parsePullRequestUrl(`https://github.com/o/r/pull/${"9".repeat(25)}`)).toBeNull()
	})
})

describe("extractIssueIdsFromText", () => {
	it("finds an issue linked by dashboard URL", () => {
		const body = `Fixes the crash.\n\nMaple: ${APP}/errors/issues/${ISSUE}\n`
		expect(extractIssueIdsFromText(body, APP)).toEqual([ISSUE])
	})

	it("finds an issue named by explicit token", () => {
		expect(extractIssueIdsFromText(`closes maple-issue:${ISSUE}`, APP)).toEqual([ISSUE])
	})

	it("ignores an issue URL from a different Maple deployment", () => {
		const body = `see https://someone-else.example.com/errors/issues/${ISSUE}`
		expect(extractIssueIdsFromText(body, APP)).toEqual([])
	})

	it("does not treat a bare issue number as a Maple reference", () => {
		// The whole reason `Fixes #123` is unsupported: it names a GitHub issue.
		expect(extractIssueIdsFromText("Fixes #123\nCloses #456", APP)).toEqual([])
	})

	it("returns nothing when there is no reference at all", () => {
		expect(extractIssueIdsFromText("Refactor the parser. No issue.", APP)).toEqual([])
		expect(extractIssueIdsFromText("", APP)).toEqual([])
	})

	it("deduplicates an issue referenced both ways and in both cases", () => {
		const body = [
			`${APP}/errors/issues/${ISSUE}`,
			`maple-issue:${ISSUE.toUpperCase()}`,
			`${APP}/errors/issues/${ISSUE}`,
		].join("\n")
		expect(extractIssueIdsFromText(body, APP)).toEqual([ISSUE])
	})

	it("finds several distinct issues in one body", () => {
		const body = `${APP}/errors/issues/${ISSUE} and maple-issue:${OTHER_ISSUE}`
		expect([...extractIssueIdsFromText(body, APP)].sort()).toEqual([ISSUE, OTHER_ISSUE].sort())
	})

	it("stops the URL match at surrounding markdown punctuation", () => {
		const body = `Fixes [the bug](${APP}/errors/issues/${ISSUE}).`
		expect(extractIssueIdsFromText(body, APP)).toEqual([ISSUE])
	})

	it("still finds the token form when the app base URL is unusable", () => {
		expect(extractIssueIdsFromText(`maple-issue:${ISSUE}`, "not-a-url")).toEqual([ISSUE])
	})
})
