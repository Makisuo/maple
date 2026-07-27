import { beforeEach, describe, expect, test } from "bun:test";
import {
  promoteThreadFollowUp,
  resetThreadEngagementCacheForTests,
  type ThreadFollowUpDeps,
  type ThreadReplyMessage,
} from "./thread-follow-up.js";

const BOT_USER_ID = "U0BOT";

// ── helpers ─────────────────────────────────────────────────────────────────

function envelope(overrides: {
  event?: Record<string, unknown>;
  envelope?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    type: "event_callback",
    team_id: "T123",
    event_id: "Ev123",
    authorizations: [{ user_id: BOT_USER_ID, is_bot: true }],
    event: {
      type: "message",
      channel_type: "channel",
      channel: "C123",
      user: "U456",
      text: "can you investigate the root cause?",
      ts: "1700000002.000200",
      thread_ts: "1700000000.000100",
      ...overrides.event,
    },
    ...overrides.envelope,
  });
}

function makeDeps(replies: readonly ThreadReplyMessage[]): {
  deps: ThreadFollowUpDeps;
  calls: () => number;
} {
  let fetchCalls = 0;
  return {
    deps: {
      resolveBotToken: async () => "xoxb-test",
      fetchThreadReplies: async () => {
        fetchCalls += 1;
        return replies;
      },
    },
    calls: () => fetchCalls,
  };
}

const ENGAGED_THREAD: readonly ThreadReplyMessage[] = [
  { user: "U456", text: `<@${BOT_USER_ID}> why is error rate up?` },
  { user: BOT_USER_ID, text: "Here are the reasons why..." },
];

const UNRELATED_THREAD: readonly ThreadReplyMessage[] = [
  { user: "U456", text: "lunch?" },
  { user: "U789", text: "sure" },
];

beforeEach(() => {
  resetThreadEngagementCacheForTests();
});

// ── promotion ───────────────────────────────────────────────────────────────

describe("promoteThreadFollowUp", () => {
  test("promotes a follow-up reply in an engaged thread to app_mention", async () => {
    const { deps } = makeDeps(ENGAGED_THREAD);
    const promoted = await promoteThreadFollowUp(envelope({}), deps);
    expect(promoted).not.toBeNull();
    const parsed = JSON.parse(promoted!) as {
      event: Record<string, unknown>;
      event_id: string;
    };
    expect(parsed.event.type).toBe("app_mention");
    // Everything else is preserved so eve's parser sees a coherent event.
    expect(parsed.event.channel).toBe("C123");
    expect(parsed.event.thread_ts).toBe("1700000000.000100");
    expect(parsed.event.user).toBe("U456");
    expect(parsed.event_id).toBe("Ev123");
  });

  test("promotes when the bot was mentioned in the thread but has not replied yet", async () => {
    const { deps } = makeDeps([
      { user: "U456", text: `<@${BOT_USER_ID}> why is error rate up?` },
    ]);
    expect(await promoteThreadFollowUp(envelope({}), deps)).not.toBeNull();
  });

  test("private-channel (group) replies qualify too", async () => {
    const { deps } = makeDeps(ENGAGED_THREAD);
    const body = envelope({ event: { channel_type: "group" } });
    expect(await promoteThreadFollowUp(body, deps)).not.toBeNull();
  });

  test("file_share subtype replies qualify (mirrors eve's DM filter)", async () => {
    const { deps } = makeDeps(ENGAGED_THREAD);
    const body = envelope({ event: { subtype: "file_share" } });
    expect(await promoteThreadFollowUp(body, deps)).not.toBeNull();
  });
});

// ── pass-through cases ──────────────────────────────────────────────────────

describe("pass-through", () => {
  test("thread the bot is not part of", async () => {
    const { deps } = makeDeps(UNRELATED_THREAD);
    expect(await promoteThreadFollowUp(envelope({}), deps)).toBeNull();
  });

  test("reply that already @-mentions the bot (arrives as a real app_mention)", async () => {
    const { deps, calls } = makeDeps(ENGAGED_THREAD);
    const body = envelope({
      event: { text: `<@${BOT_USER_ID}> and what about latency?` },
    });
    expect(await promoteThreadFollowUp(body, deps)).toBeNull();
    // Rejected before any Slack API call.
    expect(calls()).toBe(0);
  });

  test("bot-authored replies (no self-triggering loop)", async () => {
    const { deps, calls } = makeDeps(ENGAGED_THREAD);
    const body = envelope({ event: { bot_id: "B999" } });
    expect(await promoteThreadFollowUp(body, deps)).toBeNull();
    expect(calls()).toBe(0);
  });

  test("top-level channel messages (not a thread reply)", async () => {
    const { deps } = makeDeps(ENGAGED_THREAD);
    const noThread = envelope({ event: { thread_ts: undefined } });
    expect(await promoteThreadFollowUp(noThread, deps)).toBeNull();
    const rootOfThread = envelope({
      event: { ts: "1700000000.000100", thread_ts: "1700000000.000100" },
    });
    expect(await promoteThreadFollowUp(rootOfThread, deps)).toBeNull();
  });

  test("DMs (eve dispatches those on its own)", async () => {
    const { deps } = makeDeps(ENGAGED_THREAD);
    const body = envelope({ event: { channel_type: "im" } });
    expect(await promoteThreadFollowUp(body, deps)).toBeNull();
  });

  test("edits and other subtypes", async () => {
    const { deps } = makeDeps(ENGAGED_THREAD);
    const body = envelope({ event: { subtype: "message_changed" } });
    expect(await promoteThreadFollowUp(body, deps)).toBeNull();
  });

  test("non-message events", async () => {
    const { deps } = makeDeps(ENGAGED_THREAD);
    const body = envelope({ event: { type: "reaction_added" } });
    expect(await promoteThreadFollowUp(body, deps)).toBeNull();
  });

  test("envelope without authorizations (bot user unknown)", async () => {
    const { deps } = makeDeps(ENGAGED_THREAD);
    const body = envelope({ envelope: { authorizations: undefined } });
    expect(await promoteThreadFollowUp(body, deps)).toBeNull();
  });

  test("interaction form posts / non-JSON bodies", async () => {
    const { deps } = makeDeps(ENGAGED_THREAD);
    expect(await promoteThreadFollowUp("payload=%7B%7D", deps)).toBeNull();
  });

  test("url_verification and other envelope types", async () => {
    const { deps } = makeDeps(ENGAGED_THREAD);
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });
    expect(await promoteThreadFollowUp(body, deps)).toBeNull();
  });
});

// ── caching ─────────────────────────────────────────────────────────────────

describe("engagement cache", () => {
  test("second follow-up in the same thread skips the Slack API call", async () => {
    const { deps, calls } = makeDeps(ENGAGED_THREAD);
    await promoteThreadFollowUp(envelope({}), deps);
    const second = envelope({ event: { ts: "1700000003.000300" } });
    expect(await promoteThreadFollowUp(second, deps)).not.toBeNull();
    expect(calls()).toBe(1);
  });

  test("threads are cached independently", async () => {
    const { deps, calls } = makeDeps(ENGAGED_THREAD);
    await promoteThreadFollowUp(envelope({}), deps);
    const otherThread = envelope({
      event: { thread_ts: "1700000010.000100", ts: "1700000011.000200" },
    });
    await promoteThreadFollowUp(otherThread, deps);
    expect(calls()).toBe(2);
  });
});
