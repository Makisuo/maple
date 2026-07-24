import { describe, expect, it } from "vitest"
import { classifyUnplayable } from "./replay-player-context"

// When a session has no playable frames, the player must say *why*. Getting
// this wrong is user-visible in both directions: calling a live upload
// "not recorded" is a lie for the whole time someone watches a live session,
// and calling a metadata-only session "still recording" leaves them waiting on
// frames that are never coming.

describe("classifyUnplayable", () => {
	describe("with the SDK marker present", () => {
		it("trusts a false marker over everything else", () => {
			expect(classifyUnplayable({ recorded: false, chunkCount: 0, sessionActive: false })).toBe(
				"unrecorded",
			)
			// Even while the session is open: the SDK already told us no recorder
			// is running, so no chunks are coming no matter how long we wait.
			expect(classifyUnplayable({ recorded: false, chunkCount: 0, sessionActive: true })).toBe(
				"unrecorded",
			)
		})

		it("keeps a marked-recorded session in the still-arriving state", () => {
			// A recorder ran, so chunks exist or are in flight — never "unrecorded",
			// however few frames decoded.
			expect(classifyUnplayable({ recorded: true, chunkCount: 0, sessionActive: true })).toBe("empty")
			expect(classifyUnplayable({ recorded: true, chunkCount: 1, sessionActive: false })).toBe("empty")
		})
	})

	// Sessions written before the SDK stamped the marker. The only safe
	// inference is "closed and never wrote a chunk".
	describe("without the marker (legacy sessions)", () => {
		it("calls a closed, chunkless session unrecorded", () => {
			expect(classifyUnplayable({ recorded: undefined, chunkCount: 0, sessionActive: false })).toBe(
				"unrecorded",
			)
		})

		it("does not guess while the session is still open", () => {
			expect(classifyUnplayable({ recorded: undefined, chunkCount: 0, sessionActive: true })).toBe(
				"empty",
			)
		})

		it("does not guess when chunks exist but decoded too short to play", () => {
			expect(classifyUnplayable({ recorded: undefined, chunkCount: 3, sessionActive: false })).toBe(
				"empty",
			)
		})
	})
})
