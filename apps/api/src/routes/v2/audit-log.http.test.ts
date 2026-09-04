import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { UserId } from "@maple/domain/primitives"
import type { AuditLogEntry } from "@/services/audit/audit-event"
import { actorDisplayName } from "./audit-log.http"

const USER = Schema.decodeUnknownSync(UserId)("user_audit_route_test")

type Named = Pick<AuditLogEntry, "actorLabel" | "userId">

describe("actorDisplayName", () => {
	it("prefers the label frozen at write time over the current directory", () => {
		const row: Named = { actorLabel: "Deploy bot", userId: USER }
		expect(actorDisplayName(row, new Map([[USER, "Ada Lovelace"]]))).toBe("Deploy bot")
	})

	it("names a dashboard actor from the directory", () => {
		const row: Named = { actorLabel: null, userId: USER }
		expect(actorDisplayName(row, new Map([[USER, "Ada Lovelace"]]))).toBe("Ada Lovelace")
	})

	// A member who has since left the org is exactly the actor an audit reader
	// cares about, so an unresolvable id must still render as itself rather than
	// dropping the row or erroring.
	it("leaves a departed member unnamed", () => {
		const row: Named = { actorLabel: null, userId: USER }
		expect(actorDisplayName(row, new Map())).toBeNull()
	})

	it("has nothing to name for a system entry", () => {
		expect(actorDisplayName({ actorLabel: null, userId: null }, new Map())).toBeNull()
	})
})
