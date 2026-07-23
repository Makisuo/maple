import { describe, expect, test } from "bun:test";
import type { ApprovalContext } from "eve/tools";
import {
  baseToolName,
  MUTATING_TOOL_NAMES,
  mapleToolApproval,
} from "./approval.js";

// ── helpers ─────────────────────────────────────────────────────────────────

type AuthOverrides = {
  authenticator?: string;
  principalId?: string;
  principalType?: string;
};

function approvalCtx(
  toolName: string,
  auth: AuthOverrides | null = {},
): ApprovalContext {
  const current =
    auth === null
      ? null
      : {
          authenticator: auth.authenticator ?? "slack-webhook",
          principalId: auth.principalId ?? "slack:T123:U456",
          principalType: auth.principalType ?? "user",
          issuer: "slack:T123",
          attributes: { team_id: "T123", user_id: "U456" },
        };
  // Only the fields the policy reads are populated; the rest of the
  // SessionContext surface is irrelevant to a pure approval decision.
  return {
    toolName,
    callId: "call_1",
    approvedTools: new Set<string>(),
    session: {
      id: "session_1",
      auth: { current, initiator: current },
      turn: { id: "turn_0", sequence: 0 },
    },
  } as unknown as ApprovalContext;
}

const APP_PRINCIPAL: AuthOverrides = {
  authenticator: "app",
  principalId: "eve:app",
  principalType: "runtime",
};

// ── baseToolName ────────────────────────────────────────────────────────────

describe("baseToolName", () => {
  test("strips the maple__ connection qualifier", () => {
    expect(baseToolName("maple__create_alert_rule")).toBe("create_alert_rule");
  });

  test("leaves unqualified names untouched", () => {
    expect(baseToolName("create_alert_rule")).toBe("create_alert_rule");
  });

  test("does not strip other connection prefixes", () => {
    expect(baseToolName("linear__create_issue")).toBe("linear__create_issue");
  });
});

// ── mapleToolApproval ───────────────────────────────────────────────────────

describe("mapleToolApproval", () => {
  test("requires user approval for every mutating tool (qualified)", () => {
    for (const name of MUTATING_TOOL_NAMES) {
      expect(mapleToolApproval(approvalCtx(`maple__${name}`))).toBe(
        "user-approval",
      );
    }
  });

  test("read-only tools pass through without a prompt", () => {
    for (const name of ["find_errors", "system_health", "inspect_trace"]) {
      expect(mapleToolApproval(approvalCtx(`maple__${name}`))).toBe(
        "not-applicable",
      );
    }
  });

  test("unknown tool names pass through", () => {
    expect(mapleToolApproval(approvalCtx("maple__some_future_tool"))).toBe(
      "not-applicable",
    );
  });

  test("denies mutating tools on app-principal (automated) turns", () => {
    const status = mapleToolApproval(
      approvalCtx("maple__create_alert_rule", APP_PRINCIPAL),
    );
    expect(status).toEqual({
      type: "denied",
      reason: "Automated turns cannot perform mutations.",
    });
  });

  test("app-principal turns may still run read-only tools", () => {
    expect(
      mapleToolApproval(approvalCtx("maple__system_health", APP_PRINCIPAL)),
    ).toBe("not-applicable");
  });

  test("a partial app-principal match still prompts instead of denying", () => {
    // service principals (e.g. Slack bot authors) are not the app principal
    const status = mapleToolApproval(
      approvalCtx("maple__create_alert_rule", {
        authenticator: "slack-webhook",
        principalId: "slack:T123:bot:B1",
        principalType: "service",
      }),
    );
    expect(status).toBe("user-approval");
  });

  test("no auth context at all still requires approval for mutations", () => {
    expect(mapleToolApproval(approvalCtx("maple__create_alert_rule", null))).toBe(
      "user-approval",
    );
  });
});

// ── drift canary ────────────────────────────────────────────────────────────

// Mirrors apps/api/src/mcp/tools/mutating.ts and
// apps/chat-flue/src/lib/approval.ts. If this snapshot fails, either sync all
// three copies deliberately or revert the accidental edit.
describe("MUTATING_TOOL_NAMES", () => {
  test("matches the mirrored literal set", () => {
    expect([...MUTATING_TOOL_NAMES].sort()).toEqual(
      [
        "create_dashboard",
        "update_dashboard",
        "add_dashboard_widget",
        "update_dashboard_widget",
        "remove_dashboard_widget",
        "reorder_dashboard_widgets",
        "replace_dashboard_widgets",
        "create_alert_rule",
        "update_alert_rule",
        "delete_alert_rule",
        "claim_error_issue",
        "release_error_issue",
        "transition_error_issue",
        "comment_on_error_issue",
        "heartbeat_error_issue",
        "set_issue_severity",
        "update_error_notification_policy",
        "propose_fix",
        "register_agent",
      ].sort(),
    );
  });
});
