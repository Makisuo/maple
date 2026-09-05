import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { UserId } from "@maple/domain/primitives"
import type { AuditLogEntry } from "@/services/audit/audit-event"
import { actorAvatarUrl, actorDisplayName, type ActorProfile } from "./audit-log.http"

const USER = Schema.decodeUnknownSync(UserId)("user_audit_route_test")

const directory = (profile: ActorProfile) => new Map([[USER, profile]])
const ada: ActorProfile = { name: "Ada Lovelace", imageUrl: "https://img.test/ada.png" }

type Row = Pick<AuditLogEntry, "actorLabel" | "userId" | "actorType">

describe("actorDisplayName", () => {
	it("prefers the label frozen at write time over the current directory", () => {
		const row: Row = { actorLabel: "Deploy bot", userId: USER, actorType: "api_key" }
		expect(actorDisplayName(row, directory(ada))).toBe("Deploy bot")
	})

	it("names a dashboard actor from the directory", () => {
		const row: Row = { actorLabel: null, userId: USER, actorType: "user" }
		expect(actorDisplayName(row, directory(ada))).toBe("Ada Lovelace")
	})

	// A member who has since left the org is exactly the actor an audit reader
	// cares about, so an unresolvable id must still render as itself rather than
	// dropping the row or erroring.
	it("leaves a departed member unnamed", () => {
		const row: Row = { actorLabel: null, userId: USER, actorType: "user" }
		expect(actorDisplayName(row, new Map())).toBeNull()
	})

	// An API-key row carries the minting user's id. Naming it from the directory
	// would print a person's name on an action a key took.
	it("does not lend a minting user's name to their API key", () => {
		const row: Row = { actorLabel: null, userId: USER, actorType: "api_key" }
		expect(actorDisplayName(row, directory(ada))).toBeNull()
	})

	it("has nothing to name for a system entry", () => {
		expect(actorDisplayName({ actorLabel: null, userId: null, actorType: "system" }, new Map())).toBeNull()
	})
})

describe("actorAvatarUrl", () => {
	it("shows the directory avatar for a user", () => {
		expect(actorAvatarUrl({ actorType: "user", userId: USER }, directory(ada))).toBe(
			"https://img.test/ada.png",
		)
	})

	// The key acted, not the person who minted it: showing that person's face
	// would misattribute the action to a human who may not have been involved.
	it("gives an API key no face even though the entry carries a user id", () => {
		expect(actorAvatarUrl({ actorType: "api_key", userId: USER }, directory(ada))).toBeNull()
	})

	it("has none for a member the directory does not know", () => {
		expect(actorAvatarUrl({ actorType: "user", userId: USER }, new Map())).toBeNull()
	})

	it("tolerates a member with no avatar", () => {
		const noFace: ActorProfile = { name: "Ada Lovelace", imageUrl: null }
		expect(actorAvatarUrl({ actorType: "user", userId: USER }, directory(noFace))).toBeNull()
	})
})
