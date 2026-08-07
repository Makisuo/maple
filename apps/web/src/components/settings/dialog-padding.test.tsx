import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
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
	// The primitives themselves define the padding these rules check for.
	.filter((f) => !/packages\/ui\/src\/components\/ui\/(alert-)?dialog\.tsx$/.test(f))

/** Any explicit horizontal padding counts — `spend-limit-dialog` opts out of `p-6` and uses `px-5`. */
const HAS_H_PADDING = /\bp-\d|\bpx-\d|\bpx-\[/

const stripComments = (s: string) => s.replaceAll(/\{\/\*.*?\*\/\}/gs, "").trim()

function bodiesBetween(source: string, header: string, footer: string): string[] {
	const re = new RegExp(`</${header}>(.*?)<${footer}`, "gs")
	return [...source.matchAll(re)].map((m) => stripComments(m[1] ?? ""))
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
				.filter((body) => !body.includes("DialogPanel") && !HAS_H_PADDING.test(body))
				.map(() => file),
		)
		expect(offenders).toEqual([])
	})

	it("every AlertDialog body pads itself", () => {
		// AlertDialog exports no panel component, so there is no primitive to lean on.
		const offenders = sources.flatMap(({ file, source }) =>
			bodiesBetween(source, "AlertDialogHeader", "AlertDialogFooter")
				.filter((body) => body.length > 0)
				.filter((body) => !HAS_H_PADDING.test(body))
				.map(() => file),
		)
		expect(offenders).toEqual([])
	})
})
