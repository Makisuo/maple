# The error issue lifecycle

How an error goes from "something threw in production" to "fixed, and we checked".

This is the flow both humans and agents are meant to follow. If you are changing anything under
`apps/api/src/services/errors/`, this page is the contract you are changing.

## The pieces

| Thing                      | Where it lives                        | What it is                                                    |
| -------------------------- | ------------------------------------- | ------------------------------------------------------------- |
| Occurrence                 | ClickHouse / Tinybird                 | One exception, one row. Never mutated.                        |
| Fingerprint                | `cityHash64(org, service, type, frame)` | The identity of an error *class*.                            |
| Candidate                  | `error_fingerprint_candidates`        | A fingerprint seen, but not yet worth a row of its own.       |
| **Issue**                  | `error_issues`                        | The durable, assignable record. One per fingerprint.          |
| Incident                   | `error_incidents`                     | A time-bounded flare-up *under* an issue.                     |
| Investigation              | `investigations`                      | One AI diagnostic run. Zero or more per issue.                |
| Verification               | `error_issue_verifications`           | One post-merge "did that actually work?" check.               |

The exception an occurrence records comes from the span's first OTel `exception` event; a span
without one (Cloudflare's native Workers tracing cannot record events) is read from its
`exception.*` span attributes, then `error.type` / `error.message`, then the status message, and
only then labelled `Unknown Error`. The precedence lives in `error_events_mv`
(`packages/domain/src/tinybird/materializations.ts`) and its TypeScript mirror `fingerprint.ts`.

The distinction that matters: **an incident is a flare-up, an issue is the bug**. An issue can flare
up ten times; it gets fixed once.

## The flow

```
        occurrences
             │
             ▼
     ┌───────────────┐   below PROMOTION_MIN_OCCURRENCES: stays here,
     │   candidate   │   pruned by retention, notifies nobody
     └───────┬───────┘
             ▼
         ┌────────┐        the errors tick opens an incident and notifies
         │ triage │◄────┐  per the org's error notification policy
         └───┬────┘     │
             │          │  snooze expiry
   AI investigation     │
   (if the org enabled it)
             │          │
             ▼          │
        ┌─────────┐     │
        │  todo   │─────┤
        └────┬────┘     │
             ▼          │
      ┌─────────────┐   │
      │ in_progress │───┤   claimed: one lease, so two agents can't both fix it
      └──────┬──────┘   │
             ▼          │
       ┌───────────┐    │
       │ in_review │    │   a fix is proposed, a PR is attached
       └─────┬─────┘    │
             │ PR merges│
             ▼          │
       ┌───────────┐    │
       │ verifying │    │   nobody acts. Maple watches for a window sized by
       └─────┬─────┘    │   the issue's severity and its own pre-merge rate
             │          │
    ┌────────┼────────┐ │
    ▼        ▼        ▼ │
 verified  not_fixed  inconclusive
    │        │          │
    │        └──────────┴──► back to in_progress / in_review
    ▼
 ┌──────┐   low/medium/untriaged: closed automatically.
 │ done │   high/critical: the verdict is posted, a human closes it.
 └──┬───┘
    │ an occurrence from a build that postdates the fix
    ▼
┌───────────┐
│ regressed │  NOT `triage` — the issue remembers it was fixed once, so the
└───────────┘  next person doesn't fix the same bug a second time
```

`cancelled` and `wontfix` are the exits off to the side. `wontfix` takes an optional `snoozeUntil`
and wakes back into `triage` when it expires.

## Who owns which edge

Three actors move issues, and the split is the whole design:

- **Humans and agents** move an issue through the states that record an *intention*: `triage`,
  `todo`, `in_progress`, `in_review`, `done`, `cancelled`, `wontfix`.
- **The errors tick** (every minute) owns `regressed`. It records an *observation* — this error
  fired from a build that was not running when it was resolved — and it would overwrite any
  human claim to the contrary on its next pass.
- **The verification tick** (every minute) owns `verifying` and the exit from it.

`regressed` and `verifying` are therefore in `MACHINE_OWNED_WORKFLOW_STATES`: legal edges in
`WORKFLOW_TRANSITIONS` because the ticks travel them, but filtered out of every surface that lets
somebody *choose* a state — the web state picker, the bulk bar, and the `transition_error_issue`
MCP tool, which rejects them with an explanation.

The single source of truth for all of this is `WORKFLOW_TRANSITIONS` in
`packages/domain/src/http/errors.ts`. The MCP tool description is rendered from it at registration
time by `describeWorkflowTransitions()`, so the rules an agent is told can never drift from the
rules the server enforces.

## Where the AI enters

There are exactly **three** places, and they do different jobs:

### 1. Auto-investigation on a new incident

Off by default; an admin opts in per org (`ai_triage_settings`). When an incident opens — first-seen
or regression — `maybeEnqueueTriage` starts an investigation, subject to a daily budget counted in
*model passes*, not runs (`maxPassesPerDay`, default 90; one fanned-out incident is about six
passes).

The run either takes the single-pass path or fans out: a **planner** writes hypotheses for this
specific incident, each is dispatched to its own **lens** agent, and a **validator** ranks them and
promotes one cause. Everything it decided — including the hypotheses it chose *not* to test — is
persisted on the investigation, which is what makes a conclusion readable a week later.

The result lands back on the issue as an `ai_triage` timeline event plus an applied severity.
Severity is what escalates, so an AI-set severity can page people (`issue_escalations`), gated on
the run's own confidence.

### 2. An agent working the issue over MCP

An external coding agent claims an issue, reads its timeline, fixes the bug, and attaches a PR.
The lease is what keeps two agents off the same bug; it renews on every action and is dropped when
the issue closes.

**The claim is taken by the work, not by a ceremony before it.** `propose_fix` and a transition to
`in_progress` both acquire the lease. This is not a convenience — it is the fix to the flow's worst
failure. For as long as claiming was a separate step an agent was merely *told* to take, it was
never taken once: across 50 live issues in the internal org every `lease_holder` was null, and the
most common MCP error in the org was `Illegal transition from 'triage' to 'in_review'`, which is
`propose_fix` being rejected on an issue nobody had claimed. Agents responded by hand-walking
`transition_error_issue` instead, which "worked" and left the lease empty. A guarantee that depends
on an agent reading a rule is not a guarantee.

The agent-facing map of this flow lives in the `maple://instructions` MCP resource, and the
`issue-workflow.eval.ts` cases check a real model still picks these tools. Keep both in sync with
this page.

### 3. Post-merge verification

When a linked PR merges, the issue moves to `verifying` and a window opens. Its length comes from
the issue's severity band and its own pre-merge occurrence rate, so it is six hours for a noisy
error and days for a rare one.

When the window closes, the tick reads the warehouse first. **The deterministic evidence decides
most cases**: occurrences are split against `baselineVersionsJson`, a snapshot of the builds the
issue had been seen from at merge time. An occurrence from a build already in that set is an old
client still in the wild; one from a build absent from it is the fix demonstrably not working, and
that alone refutes the fix without asking an agent anything.

Only a *clean* window goes to an agent, and it is asked the inverted question: not "what is wrong"
but "find anything that contradicts this fix holding". Hence the mapping in
`verdictFromInvestigationStatus`, which reads backwards until you hold that question — an agent that
*establishes* a cause means `not_fixed`, and an agent that finds nothing means `verified`.

An inconclusive verdict re-arms exactly one longer window and then gives up, so an issue can never
loop in verification without a human ever seeing it.

## Rules worth not re-deriving

- **Never make the claim a step an agent has to remember.** Any new tool that starts work on an
  issue takes the lease itself. See above for what happened when it did not.
- **An issue with a linked PR should not be closed by hand.** The merge opens the verification
  window and the verdict closes it. Closing early throws the check away.
- **`verified` does not always mean closed.** Low, medium and untriaged issues auto-close; high and
  critical get the verdict posted and wait for a human. The cost of a wrong auto-close scales with
  severity; the value of saving a click does not.
- **A regression is not a new bug.** `lastResolvedAt`, `regressionCount` and the `regressed` state
  exist so that the second person to pick up an issue knows it was fixed once already.
- **Versions are compared by membership, never by ordering.** `maple-cli` reports semver and the
  Workers report git SHAs; "newer than the fix" is not a question those strings can answer.
- **Severity has three sources with a precedence**: manual > ai > detector (`IssueSeveritySource`).

## The files

| Concern                                | File                                                            |
| -------------------------------------- | --------------------------------------------------------------- |
| State machine, transitions, labels     | `packages/domain/src/http/errors.ts`                            |
| Verification windows, verdicts         | `packages/domain/src/http/fix-verification.ts`                  |
| Transitions, leases, timeline events   | `apps/api/src/services/errors/ErrorIssueWorkflowService.ts`     |
| The errors tick (incidents, regression)| `apps/api/src/services/errors/error-tick-persistence.ts`        |
| Starting an investigation              | `apps/api/src/services/errors/ai-triage-enqueue.ts`             |
| Planner / lenses / validator           | `apps/api/src/workflows/`                                       |
| Writing a diagnosis back               | `apps/api/src/services/errors/apply-diagnosis.ts`               |
| PR links and verification windows      | `apps/api/src/services/errors/IssueFixVerificationService.ts`   |
| The verification tick                  | `apps/api/src/services/errors/FixVerificationTickService.ts`    |
| What agents are told                   | `apps/api/src/mcp/resources/instructions.ts`                    |
