/**
 * `buildDiagnosisCompletion` — the one value an investigation turn answers through.
 *
 * The tool and the fact that calling it *ends the turn* used to be two independent inputs to the
 * loop: a `Tools` record and a `closingSubmit: { toolName }`. The chat session supplied the first
 * and never the second, so an autonomous investigation that spent its whole step budget reached the
 * tool-less closing step and filed no diagnosis at all. These pin both halves to the same value.
 */
import { OrgId, UserId } from "@maple/domain/primitives"
import { CloudflareWorkersAI } from "@opencode-ai/ai/providers/cloudflare"
import { Effect, Schema } from "effect"
import { assert, describe, it } from "vitest"
import { buildDiagnosisCompletion, type SubmitDiagnosis } from "./tools"
import { makeTurnUsage } from "./loop"
import type { TenantContext } from "@/services/auth/tenant-context"

const orgId = Schema.decodeSync(OrgId)("org_test")
const human = Schema.decodeSync(UserId)("user_test")
const internal = Schema.decodeSync(UserId)("internal-service")

const tenantFor = (userId: UserId): TenantContext => ({
	orgId,
	userId,
	roles: [],
	authMode: "self_hosted",
})

const MODEL = CloudflareWorkersAI.configure({ accountId: "test", apiKey: "test" }).model("@cf/test/model")

const INVESTIGATION_SESSION = `${orgId}:inv-00000000-0000-0000-0000-000000000000`

const submitDiagnosis: SubmitDiagnosis = () => Effect.succeed(undefined)

const build = (sessionId: string, userId: UserId) =>
	buildDiagnosisCompletion(sessionId, tenantFor(userId), submitDiagnosis, makeTurnUsage(), MODEL)

describe("buildDiagnosisCompletion", () => {
	it("gives an ordinary conversation no completion at all", () => {
		assert.isUndefined(build(`${orgId}:tab`, human))
	})

	it("gives a session whose inv- suffix is not an id no completion", () => {
		assert.isUndefined(build(`${orgId}:inv-not-a-uuid`, human))
	})

	/**
	 * The production bug. The autonomous pass answers *through* `submit_diagnosis` — it is the only
	 * thing that writes `investigations.diagnosis` — so the turn has to close on it.
	 */
	it("closes the autonomous investigation turn on submit_diagnosis", () => {
		const completion = build(INVESTIGATION_SESSION, internal)

		assert.equal(completion?.name, "submit_diagnosis")
		assert.isTrue(completion?.closes)
	})

	/**
	 * A human follow-up in the same session gets the same tool and does not close on it: it may file
	 * a superseding diagnosis, but "what did you mean by the pool?" must be answerable in prose.
	 */
	it("offers, without forcing, the same tool to a human follow-up", () => {
		const completion = build(INVESTIGATION_SESSION, human)

		assert.equal(completion?.name, "submit_diagnosis")
		assert.isFalse(completion?.closes)
	})
})
