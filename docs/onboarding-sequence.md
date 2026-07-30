# Onboarding sequence (Bento)

The onboarding drip lives in Bento, not in this repo. Bento keeps no reviewable
history, so **this file is the spec** — change it in a PR first, then make the
change in Bento. A drift check diffs the live flows against it.

Email *content* is still authored here: [`packages/email/src/onboarding.tsx`](../packages/email/src/onboarding.tsx)
renders to [`packages/email/bento-html/`](../packages/email/bento-html/) via
`bun run --cwd packages/email build:onboarding-html`.

## Subscriber fields

Written by the daily sync tick. Every flow decision reads these, never event
payloads — a payload is gone by the time a step three days later fires.

| Field | Written when | Used for |
|---|---|---|
| `maple_org_id` | subscriber upsert | joining back to `org_onboarding_state` |
| `maple_cohort` | subscriber upsert, never updated | flow entry gate: `live` or `legacy` |
| `maple_dashboard_url` | subscriber upsert | the `{{ visitor.maple_dashboard_url }}` tag in every template |
| `maple_activated` | set `true` when non-demo telemetry is first seen | the branch conditions below |

`maple_cohort` is fail-closed: anything not explicitly `live` never drips.

## Flow A — Onboarding

**Trigger:** Event received → `maple.onboarding.started`
**Entry condition:** `maple_cohort` equals `live`
**Enter once per subscriber:** on
**Status:** Draft until the canary; then Active

```
Send  01-welcome        "Welcome to Maple"
Wait  1 day
If    maple_activated == true  ──► end
Send  02-connect-app    "Connect your app to Maple"
Wait  2 days
If    maple_activated == true  ──► end
Send  03-stalled        "Need a hand connecting your app?"
end
```

Timing matches the old ladder: nudge at day 1, stalled at day 3.

## Flow B — Activated

**Trigger:** Event received → `maple.onboarding.activated`
**Entry condition:** `maple_cohort` equals `live`
**Enter once per subscriber:** on

```
Send  04-activation     "You're live on Maple"
```

Separate flow rather than a branch in Flow A, because activation fires on its
own event at an unpredictable time — possibly before the welcome wait elapses.
A subscriber who activates mid-Flow-A exits it at the next branch and receives
this email from Flow B; the old ladder behaved the same way.

## Constraints — do not violate these

**Flows trigger on events, never on "subscriber created" or "tag added."** A
subscriber backfill necessarily touches every org, so a subscriber-creation
trigger turns any future import into a mass mailing. `POST /batch/subscribers`
is documented as not triggering flows; `POST /batch/events` is the only path
that can send. `BentoService` keeps them as separate methods for this reason.

**Bento waits count from flow entry, not from org creation.** The sync tick is
daily at 09:00 UTC, so entry lands 0–24h after signup and every subsequent wait
inherits that skew. The old ladder self-corrected (`ageMs >= 1d` against the
org's real creation time); this does not. Accepted deliberately — the drip is
approximate by nature. If it ever matters, switch the waits to date-relative
against `maple_org_created_at`.

**No exit conditions.** Bento does not document removing a subscriber from a
running flow when a condition becomes true, which is why activation is checked
by an explicit branch before each send rather than as a flow-level exit. Adding
a send to Flow A without a preceding `maple_activated` check will email people
who are already live.

## Kill switches

| Switch | Latency | Stops |
|---|---|---|
| **Pause the flow in Bento** | instant, no deploy | new entries **and** subscribers already mid-flow |
| `MAPLE_BENTO_ENABLED=false` + redeploy | ~1 min | new entries only |
| Remove `BENTO_SECRET_KEY` | deploy | new entries only |

Pausing in Bento is **primary** — it is the only switch that stops someone
already three days into Flow A. Our env flags stop emission, not delivery.
Under the old cron-driven system there was no such gap.
