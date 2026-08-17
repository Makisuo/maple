import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * `DialogContent` carries no padding of its own — it comes from `DialogHeader` (`p-6`),
 * `DialogPanel` (`p-6`) and `DialogFooter` (`px-6`). A bare `<div>` dropped between header and
 * footer therefore sits flush against the popup edge, which is easy to write and easy to miss in
 * review. `AlertDialog` has no panel slot at all, so its bodies pad themselves.
 *
 * This sweeps every component rather than trusting each author to remember. It includes untracked
 * files on purpose — a plain `git ls-files` hides brand-new components, which is exactly when the
 * mistake gets made, so the sweep would pass vacuously on the code most likely to be wrong.
 */

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()

const trackedTsx = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.tsx"], {
	cwd: repoRoot,
	encoding: "utf8",
})
	.split("\n")
	.filter((f) => f.length > 0)
	.filter((f) => existsSync(join(repoRoot, f)))
	// The primitives themselves define the padding these rules check for.
	.filter((f) => !/packages\/ui\/src\/components\/ui\/(alert-)?dialog\.tsx$/.test(f))

/** Any explicit horizontal padding counts; settings dialogs opt out of `p-6` and use `px-5`. */
const HAS_H_PADDING = /\bp-\d|\bpx-\d|\bpx-\[/

const stripComments = (s: string) => s.replaceAll(/\{\/\*.*?\*\/\}/gs, "").trim()

function bodiesBetween(source: string, header: string, footer: string): string[] {
	const re = new RegExp(`</${header}>(.*?)<${footer}`, "gs")
	return [...source.matchAll(re)].map((m) => stripComments(m[1] ?? ""))
}

/**
 * Only the body's *outermost* element can pad the body. Scanning the whole body
 * string lets padding on some nested `<p className="p-3">` satisfy the check while
 * the wrapper itself sits flush against the popup edge — which is how the share
 * dialog shipped unpadded with this sweep green.
 */
function outermostTag(body: string): string {
	const open = body.indexOf("<")
	if (open === -1) return ""
	// Depth- and quote-aware, because a naive `indexOf(">")` stops inside
	// `onClick={() => …}` and inside comparisons in `cn(x > 2 && …)`.
	let depth = 0
	let quote: string | null = null
	for (let i = open; i < body.length; i++) {
		const char = body[i]
		if (quote !== null) {
			if (char === quote) quote = null
			continue
		}
		if (char === '"' || char === "'" || char === "`") quote = char
		else if (char === "{") depth++
		else if (char === "}") depth--
		else if (char === ">" && depth === 0) return body.slice(open, i + 1)
	}
	return body.slice(open)
}

describe("dialog bodies are padded", () => {
	const sources = trackedTsx.map((file) => ({
		file,
		source: readFileSync(join(repoRoot, file), "utf8"),
	}))

	it("every Dialog body uses DialogPanel or pads itself", () => {
		const offenders = sources.flatMap(({ file, source }) =>
			bodiesBetween(source, "DialogHeader", "DialogFooter")
				.filter((body) => body.length > 0)
				.map(outermostTag)
				.filter((tag) => !tag.includes("DialogPanel") && !HAS_H_PADDING.test(tag))
				.map(() => file),
		)
		expect(offenders).toEqual([])
	})

	it("every AlertDialog body pads itself", () => {
		// AlertDialog exports no panel component, so there is no primitive to lean on.
		const offenders = sources.flatMap(({ file, source }) =>
			bodiesBetween(source, "AlertDialogHeader", "AlertDialogFooter")
				.filter((body) => body.length > 0)
				.map(outermostTag)
				.filter((tag) => !HAS_H_PADDING.test(tag))
				.map(() => file),
		)
		expect(offenders).toEqual([])
	})
})
