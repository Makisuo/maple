# Agent Traces — Overview Page Design Brief

Companion to [`agent-traces-design-brief.md`](agent-traces-design-brief.md), which covers the
agent trace **detail** view. This brief covers the **overview / list** view that precedes it.

Read the detail brief first — this page must share its visual language, and several of its concepts
(what an agent trace is, the redacted state, the multi-model problem) recur here in a tighter space.

## Context

An **agent trace** is one end-to-end agent conversation, reconstructed from OpenTelemetry spans. This page
is how someone finds the agent trace they care about: a filterable, time-scoped list.

## Inherit the session replay page's architecture

Maple already has a page of exactly this shape — session replays
([`apps/web/src/routes/replays/index.tsx`](../apps/web/src/routes/replays/index.tsx)). **Match its
layout and interaction model.** Users should feel they are in the same product, and the engineering
cost drops sharply when the skeleton is shared.

The structure to inherit:

- **Header** — inline summary stats (a count plus a short label, with an optional live indicator for
  in-progress items) alongside a time-range picker with presets, defaulting to the last 24 hours.
- **Toolbar** — free-text search, plus quick-filter chips that mirror specific sidebar presets, so
  toggling either surface keeps the other in sync.
- **Left sidebar** — faceted filters. Each facet is a list of values with counts; facet counts
  exclude their own dimension, so a selected value still shows its alternatives. Numeric dimensions
  use a small histogram with a range selector and preset shortcuts derived from the data's p50/p95.
  High-cardinality identifiers get a typed text input rather than a pick list.
- **Main area** — an infinite-scrolling list of rows, with a clear indication when results are
  capped.
- **States** — skeleton loading, and a dedicated error state.

## Design deliberately: the row

This is the real work, and it does **not** carry over from replays. A session replay row summarizes
"who, from where, how long, how many errors." An agent trace row has to answer a different question, and
the columns must be designed from scratch.

Candidate content — the design should decide what earns space and what doesn't:

- Agent trace identity / title
- Agent or workflow name
- Model(s) used
- Start time and duration
- Turn count
- Tokens consumed (input and output)
- Cost
- Tool call count
- Success / error state

### Four problems the row has to solve

**1. What is an agent trace's title?** The natural label is the first user message — and that is exactly
what privacy modes strip. The identity treatment needs a fallback ladder that degrades to agent name,
then model, then an agent trace identifier, without any row ever looking empty or broken.

**2. Multiple models in one row.** An agent trace can hop between models mid-conversation. The detail
header has room to handle this; a list row does not. Needs a compact representation that stays honest
about "three models were used here."

**3. Cost is a new dimension.** Replays has no equivalent — nothing on that page is denominated in
money. Cost needs a treatment that reads at a glance, scans well down a column, and makes an
unusually expensive agent trace obvious.

**4. Redacted rows.** As in the detail view, message content is frequently unavailable while all
timing, model, token, and cost data remains intact. A list of redacted agent traces must still be
scannable and useful, not a column of placeholders.

## Design deliberately: the facets

The replay page's dimensions (browser, OS, device type, country) do not transfer. Agent trace facets are
drawn from a different vocabulary:

- Provider and model
- Agent or workflow name
- Status — succeeded, errored, in progress
- Finish reason — notably responses truncated by hitting a token limit, which are silent failures
- Whether the agent trace used tools
- Numeric ranges: duration, turn count, token count, cost

The numeric ones fit the existing histogram-plus-range pattern directly.

## One likely addition

The replay page has no sort control. Agent traces probably wants one — "most expensive", "slowest", "most
turns" are natural entry points into this data in a way that "longest session" is not for replays. If
the design agrees, sorting needs a home in the toolbar; if it disagrees, say so explicitly rather
than leaving it out silently.

## States to cover

- Loading (skeleton)
- Error
- Empty — no agent traces in the selected time range, distinct from:
- Empty — filters exclude everything, which needs a path back
- Results capped
- Rows with in-progress agent traces mixed into the list

## Out of scope

The detail view — already designed. Do not redesign it; match it.
