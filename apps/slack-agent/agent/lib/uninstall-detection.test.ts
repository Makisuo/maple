import { describe, expect, mock, test } from "bun:test"
import { forwardUninstallEvent, parseRevocationEvent, type RevocationEvent } from "./uninstall-detection.js"

const appUninstalledBody = (teamId: string) =>
	JSON.stringify({
		token: "verification-token",
		team_id: teamId,
		api_app_id: "A123",
		event: { type: "app_uninstalled" },
		type: "event_callback",
		event_id: "Ev0123",
		event_time: 1700000000,
	})

const tokensRevokedBody = (teamId: string) =>
	JSON.stringify({
		team_id: teamId,
		event: { type: "tokens_revoked", tokens: { oauth: [], bot: ["U0BOT"] } },
		type: "event_callback",
	})

describe("parseRevocationEvent", () => {
	test("parses app_uninstalled", () => {
		expect(parseRevocationEvent(appUninstalledBody("T1"))).toEqual({
			teamId: "T1",
			reason: "app_uninstalled",
		})
	})

	test("parses tokens_revoked", () => {
		expect(parseRevocationEvent(tokensRevokedBody("T2"))).toEqual({
			teamId: "T2",
			reason: "tokens_revoked",
		})
	})

	test("returns null for an unrelated event type", () => {
		const body = JSON.stringify({
			team_id: "T1",
			event: { type: "app_mention" },
			type: "event_callback",
		})
		expect(parseRevocationEvent(body)).toBeNull()
	})

	test("returns null for the url_verification handshake", () => {
		const body = JSON.stringify({ type: "url_verification", challenge: "abc" })
		expect(parseRevocationEvent(body)).toBeNull()
	})

	test("returns null when team_id is missing", () => {
		const body = JSON.stringify({ event: { type: "app_uninstalled" }, type: "event_callback" })
		expect(parseRevocationEvent(body)).toBeNull()
	})

	test("returns null for malformed JSON instead of throwing", () => {
		expect(parseRevocationEvent("not json")).toBeNull()
	})

	test("returns null for well-formed JSON that isn't an object", () => {
		expect(parseRevocationEvent("42")).toBeNull()
		expect(parseRevocationEvent("[1,2,3]")).toBeNull()
	})
})

describe("forwardUninstallEvent", () => {
	test("forwards app_uninstalled to notifyMapleRevocation", async () => {
		const notify = mock(async () => {})
		await forwardUninstallEvent(appUninstalledBody("T1"), { notifyMapleRevocation: notify })
		expect(notify).toHaveBeenCalledTimes(1)
		expect(notify).toHaveBeenCalledWith("T1", "app_uninstalled")
	})

	test("does nothing for an unrelated event", async () => {
		const notify = mock(async () => {})
		const body = JSON.stringify({ team_id: "T1", event: { type: "app_mention" }, type: "event_callback" })
		await forwardUninstallEvent(body, { notifyMapleRevocation: notify })
		expect(notify).not.toHaveBeenCalled()
	})

	test("never throws when notifyMapleRevocation rejects — reports via onError instead", async () => {
		const notify = mock(async () => {
			throw new Error("network blip")
		})
		const onError = mock((_error: unknown, _event: RevocationEvent) => {})
		await forwardUninstallEvent(appUninstalledBody("T1"), { notifyMapleRevocation: notify }, onError)
		expect(onError).toHaveBeenCalledTimes(1)
		const [error, event] = onError.mock.calls[0]!
		expect((error as Error).message).toBe("network blip")
		expect(event).toEqual({ teamId: "T1", reason: "app_uninstalled" })
	})

	test("onError is not called when there is nothing to forward", async () => {
		const notify = mock(async () => {})
		const onError = mock((_error: unknown, _event: RevocationEvent) => {})
		const body = JSON.stringify({ team_id: "T1", event: { type: "app_mention" }, type: "event_callback" })
		await forwardUninstallEvent(body, { notifyMapleRevocation: notify }, onError)
		expect(onError).not.toHaveBeenCalled()
	})
})
