import { beforeEach, describe, expect, test } from "bun:test"
import type { SlackThreadMessage } from "eve/channels/slack"
import {
	disengagementNoticeText,
	getPermalinkFromSlack,
	humanThreadParticipants,
	noticeRecipients,
	notifyThreadDisengagement,
	postDirectMessageViaSlack,
	resetDisengageNoticeStateForTests,
	type DisengageNoticeDeps,
	type ThreadDisengagement,
} from "./disengage-notice.js"
import { installFetchStub } from "./fetch-stub.js"

const BOT_USER_ID = "U0BOT"
const PERMALINK = "https://acme.slack.com/archives/C123/p1700000002000200"

const threadMessage = (overrides: Partial<SlackThreadMessage> = {}): SlackThreadMessage => ({
	text: "",
	markdown: "",
	user: undefined,
	botId: undefined,
	ts: "1700000000.000100",
	threadTs: "1700000000.000100",
	isMe: false,
	raw: {},
	...overrides,
})

const humanMessage = (user: string, ts: string): SlackThreadMessage =>
	threadMessage({ text: "…", markdown: "…", user, ts })

const disengagement = (overrides: Partial<ThreadDisengagement> = {}): ThreadDisengagement => ({
	teamId: "T123",
	channelId: "C123",
	threadTs: "1700000000.000100",
	messageTs: "1700000002.000200",
	reason: "thread-dormant",
	messages: [humanMessage("U456", "1700000000.000100"), humanMessage("U789", "1700000001.000100")],
	replierUserId: "U456",
	botUserId: BOT_USER_ID,
	...overrides,
})

function makeDeps(overrides: Partial<DisengageNoticeDeps> = {}): {
	deps: DisengageNoticeDeps
	dms: { userId: string; text: string }[]
	ephemerals: { userId: string; text: string; threadTs: string }[]
	/**
	 * Everyone told, by whichever channel reached them. Tests about *who* was
	 * notified and *what* they were told belong here; only tests about the
	 * delivery split itself should read `dms` / `ephemerals` directly.
	 */
	notices: { userId: string; text: string }[]
} {
	const dms: { userId: string; text: string }[] = []
	const ephemerals: { userId: string; text: string; threadTs: string }[] = []
	const notices: { userId: string; text: string }[] = []
	return {
		dms,
		ephemerals,
		notices,
		deps: {
			resolveBotToken: async () => "xoxb-test",
			getPermalink: async () => PERMALINK,
			postDirectMessage: async ({ userId, text }) => {
				dms.push({ userId, text })
				notices.push({ userId, text })
			},
			postEphemeral: async ({ userId, text, threadTs }) => {
				ephemerals.push({ userId, text, threadTs })
				notices.push({ userId, text })
			},
			...overrides,
		},
	}
}

beforeEach(() => {
	resetDisengageNoticeStateForTests()
})

// ── recipients ──────────────────────────────────────────────────────────────

describe("humanThreadParticipants", () => {
	test("collects every distinct human in the thread, oldest first", () => {
		expect(
			humanThreadParticipants(
				disengagement({
					messages: [
						humanMessage("U456", "1700000000.000100"),
						humanMessage("U789", "1700000001.000100"),
						humanMessage("U456", "1700000002.000100"),
					],
				}),
			),
		).toEqual(["U456", "U789"])
	})

	test("includes the author of the dropped reply, whose message is not in the thread", () => {
		// `loadThreadContextMessages` excludes the triggering message, so the one
		// person guaranteed to want this DM would otherwise be the one to miss it.
		expect(
			humanThreadParticipants(
				disengagement({
					messages: [humanMessage("U789", "1700000000.000100")],
					replierUserId: "U456",
				}),
			),
		).toEqual(["U789", "U456"])
	})

	test("excludes the bot itself and every other app", () => {
		const alertCard = threadMessage({ user: BOT_USER_ID, botId: "B0BOT", ts: "1700000000.000100" })
		const github = threadMessage({ user: "U0GH", botId: "B0GH", ts: "1700000001.000100" })
		expect(
			humanThreadParticipants(
				disengagement({
					messages: [alertCard, github, humanMessage("U456", "1700000002.000100")],
					replierUserId: "U456",
				}),
			),
		).toEqual(["U456"])
	})

	test("skips messages Slack attributed to nobody", () => {
		expect(
			humanThreadParticipants(
				disengagement({
					messages: [threadMessage({ ts: "1700000000.000100" })],
					replierUserId: undefined,
				}),
			),
		).toEqual([])
	})
})

// ── the notice ──────────────────────────────────────────────────────────────

// The two reasons describe opposite situations, so they cannot share one
// fan-out rule: `thread-dormant` is a quiet thread nobody is mid-discussion in,
// while `engagement-buried` is a *lively* one that ran past the bot — DMing
// everyone there reaches people who moved on, about someone else's message.

describe("noticeRecipients", () => {
	test("a dormant thread notifies everyone who took part", () => {
		expect(noticeRecipients(disengagement({ reason: "thread-dormant" }))).toEqual(["U456", "U789"])
	})

	test("a buried engagement notifies only the author of the unanswered reply", () => {
		expect(
			noticeRecipients(disengagement({ reason: "engagement-buried", replierUserId: "U789" })),
		).toEqual(["U789"])
	})

	test("the replier is notified even when this is their first message in the thread", () => {
		// Their message is the one that triggered this, so it is not in `messages`.
		expect(
			noticeRecipients(
				disengagement({
					reason: "engagement-buried",
					replierUserId: "U999",
					messages: [humanMessage("U456", "1700000000.000100")],
				}),
			),
		).toEqual(["U999"])
	})

	test("an unknown replier falls back to everyone rather than telling nobody", () => {
		expect(
			noticeRecipients(disengagement({ reason: "engagement-buried", replierUserId: undefined })),
		).toEqual(["U456", "U789"])
	})

	test("a replier that resolves to the bot itself falls back to everyone", () => {
		expect(
			noticeRecipients(
				disengagement({ reason: "engagement-buried", replierUserId: BOT_USER_ID }),
			),
		).toEqual(["U456", "U789"])
	})
})

describe("notifyThreadDisengagement", () => {
	test("a buried engagement reaches only the replier, in the thread", async () => {
		const { deps, dms, ephemerals } = makeDeps()
		await notifyThreadDisengagement(
			disengagement({ reason: "engagement-buried", replierUserId: "U789" }),
			deps,
		)
		expect(ephemerals.map((e) => e.userId)).toEqual(["U789"])
		expect(dms).toEqual([])
	})

	test("the replier gets it in-thread; everyone else gets a DM", async () => {
		// The replier just posted, so they are the one person we know is reading
		// the thread — the notice belongs there, not in a DM. Nobody else is
		// looking at it, and Slack renders an ephemeral for them not at all.
		const { deps, dms, ephemerals } = makeDeps()
		await notifyThreadDisengagement(
			disengagement({ reason: "thread-dormant", replierUserId: "U456" }),
			deps,
		)
		expect(ephemerals.map((e) => e.userId)).toEqual(["U456"])
		expect(dms.map((d) => d.userId)).toEqual(["U789"])
	})

	test("the in-thread notice is posted into the thread, not the channel", async () => {
		const { deps, ephemerals } = makeDeps()
		await notifyThreadDisengagement(disengagement({ replierUserId: "U456" }), deps)
		expect(ephemerals[0]?.threadTs).toBe("1700000000.000100")
	})

	test("an ephemeral that Slack drops falls back to a DM", async () => {
		// chat.postEphemeral renders nothing once the user has left the channel,
		// and Slack never stores it. A notice that evaporates is the silence this
		// whole path exists to prevent.
		const { deps, dms } = makeDeps({
			postEphemeral: async () => {
				throw new Error("user_not_in_channel")
			},
		})
		await notifyThreadDisengagement(
			disengagement({ reason: "engagement-buried", replierUserId: "U789" }),
			deps,
		)
		expect(dms.map((d) => d.userId)).toEqual(["U789"])
	})

	test("tells every human in the thread, with a permalink and how to resume", async () => {
		const { deps, notices } = makeDeps()
		await notifyThreadDisengagement(disengagement(), deps)

		expect(notices.map((n) => n.userId).sort()).toEqual(["U456", "U789"])
		for (const dm of notices) {
			expect(dm.text).toContain(PERMALINK)
			expect(dm.text).toContain("@-mention me")
			expect(dm.text).toContain("quiet for over a day")
		}
	})

	test("the permalink points at the reply that went unanswered", async () => {
		let asked: { channelId: string; messageTs: string } | undefined
		const { deps } = makeDeps({
			getPermalink: async (options) => {
				asked = { channelId: options.channelId, messageTs: options.messageTs }
				return PERMALINK
			},
		})
		await notifyThreadDisengagement(disengagement(), deps)
		expect(asked).toEqual({ channelId: "C123", messageTs: "1700000002.000200" })
	})

	test("a buried engagement is explained differently from a dormant thread", async () => {
		const { deps, notices } = makeDeps()
		await notifyThreadDisengagement(disengagement({ reason: "engagement-buried" }), deps)
		expect(notices[0]?.text).toContain("moved well past")
	})

	test("notifies once per thread, however many replies follow", async () => {
		// Otherwise every later reply in a thread the bot has left DMs everyone
		// again — a helpful nudge turned into the noise that gets an app removed.
		const { deps, notices } = makeDeps()
		await notifyThreadDisengagement(disengagement(), deps)
		await notifyThreadDisengagement(disengagement({ messageTs: "1700000003.000300" }), deps)
		expect(notices.length).toBe(2)
	})

	test("other threads are unaffected", async () => {
		const { deps, notices } = makeDeps()
		await notifyThreadDisengagement(disengagement(), deps)
		await notifyThreadDisengagement(disengagement({ threadTs: "1700000009.000100" }), deps)
		expect(notices.length).toBe(4)
	})

	test("the guard is per workspace: Slack channel ids are only unique per team", async () => {
		const { deps, notices } = makeDeps()
		await notifyThreadDisengagement(disengagement(), deps)
		await notifyThreadDisengagement(disengagement({ teamId: "T999" }), deps)
		expect(notices.length).toBe(4)
	})

	test("sends nothing when there is nobody to tell", async () => {
		const { deps, notices } = makeDeps()
		await notifyThreadDisengagement(disengagement({ messages: [], replierUserId: undefined }), deps)
		expect(notices.length).toBe(0)
	})

	test("still sends when Slack cannot produce a permalink", async () => {
		const { deps, notices } = makeDeps({ getPermalink: async () => null })
		await notifyThreadDisengagement(disengagement(), deps)
		expect(notices.length).toBe(2)
		expect(notices[0]?.text).toContain("a Slack thread")
	})

	test("a permalink failure does not cost the notice", async () => {
		const { deps, notices } = makeDeps({
			getPermalink: async () => {
				throw new Error("slack down")
			},
		})
		await expect(notifyThreadDisengagement(disengagement(), deps)).resolves.toBeUndefined()
		expect(notices.length).toBe(2)
	})

	test("one closed DM does not cost the others theirs", async () => {
		const delivered: string[] = []
		const { deps } = makeDeps({
			postDirectMessage: async ({ userId }) => {
				if (userId === "U456") throw new Error("cannot_dm_bot")
				delivered.push(userId)
			},
		})
		await expect(notifyThreadDisengagement(disengagement(), deps)).resolves.toBeUndefined()
		expect(delivered).toEqual(["U789"])
	})

	test("never throws: it is fired without awaiting and nothing is waiting on it", async () => {
		const { deps } = makeDeps({
			resolveBotToken: async () => {
				throw new Error("team not linked")
			},
		})
		await expect(notifyThreadDisengagement(disengagement(), deps)).resolves.toBeUndefined()
	})
})

describe("disengagementNoticeText", () => {
	test("reads as a sentence without the link, for the notification preview", () => {
		expect(disengagementNoticeText("thread-dormant", null)).toContain(
			"There's a new reply in a Slack thread I'd been working in",
		)
	})
})

// ── Slack request shapes ────────────────────────────────────────────────────

describe("Slack calls", () => {
	test("chat.getPermalink asks for the channel and the message", async () => {
		const stub = installFetchStub(() => Response.json({ ok: true, permalink: PERMALINK }))
		try {
			const permalink = await getPermalinkFromSlack({
				botToken: "xoxb-test",
				channelId: "C123",
				messageTs: "1700000002.000200",
			})
			expect(permalink).toBe(PERMALINK)
			const url = new URL(String(stub.calls[0]?.url))
			expect(url.pathname).toBe("/api/chat.getPermalink")
			expect(url.searchParams.get("channel")).toBe("C123")
			expect(url.searchParams.get("message_ts")).toBe("1700000002.000200")
		} finally {
			stub.restore()
		}
	})

	test("chat.getPermalink returns null rather than throwing when Slack refuses", async () => {
		const stub = installFetchStub(() => Response.json({ ok: false, error: "message_not_found" }))
		try {
			expect(
				await getPermalinkFromSlack({
					botToken: "xoxb-test",
					channelId: "C123",
					messageTs: "1700000002.000200",
				}),
			).toBeNull()
		} finally {
			stub.restore()
		}
	})

	test("chat.postMessage addresses the user id directly — Slack opens the DM", async () => {
		const stub = installFetchStub(() => Response.json({ ok: true }))
		try {
			await postDirectMessageViaSlack({ botToken: "xoxb-test", userId: "U456", text: "hi" })
			expect(stub.calls[0]?.url).toBe("https://slack.com/api/chat.postMessage")
			expect(JSON.parse(String(stub.calls[0]?.body))).toEqual({ channel: "U456", text: "hi" })
			expect(stub.calls[0]?.headers.authorization).toBe("Bearer xoxb-test")
		} finally {
			stub.restore()
		}
	})

	test("chat.postMessage surfaces a Slack-level failure to the per-recipient catch", async () => {
		const stub = installFetchStub(() => Response.json({ ok: false, error: "channel_not_found" }))
		try {
			await expect(
				postDirectMessageViaSlack({ botToken: "xoxb-test", userId: "U456", text: "hi" }),
			).rejects.toThrow("channel_not_found")
		} finally {
			stub.restore()
		}
	})
})
