import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Base UI's `<OTPField.Input>` deliberately ignores `aria-label` on the *first* input — that slot
 * carries the whole field's accessible name, which has to come from a real `<label>`. It logs a
 * warning, but a warning in a dev console is easy to miss, and the failure mode is silent: the box
 * a screen-reader user types into first is announced as an unlabelled textbox.
 */

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()

const consumers = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.tsx"], {
	cwd: repoRoot,
	encoding: "utf8",
})
	.split("\n")
	.filter((f) => f.length > 0)
	.map((file) => ({ file, source: readFileSync(join(repoRoot, file), "utf8") }))
	.filter(({ file, source }) => source.includes("<OTPFieldInput") && !file.endsWith("otp-field.tsx"))

describe("OTP fields label their first slot with a real <label>", () => {
	it("finds the known consumers", () => {
		// Guards the sweep itself: if the glob stops matching, the assertions below pass vacuously.
		expect(consumers.length).toBeGreaterThanOrEqual(2)
	})

	it("never puts aria-label on the first OTPFieldInput", () => {
		const offenders = consumers
			.filter(({ source }) => {
				// The first `<OTPFieldInput` in each field is the one Base UI overrides.
				const first = source.indexOf("<OTPFieldInput")
				const tag = source.slice(first, source.indexOf(">", first))
				return tag.includes("aria-label")
			})
			.map(({ file }) => file)
		expect(offenders).toEqual([])
	})

	it("labels the field with a Label bound to the first slot's id", () => {
		const offenders = consumers
			.filter(({ source }) => !(source.includes("<Label htmlFor=") && source.includes("useId")))
			.map(({ file }) => file)
		expect(offenders).toEqual([])
	})
})
