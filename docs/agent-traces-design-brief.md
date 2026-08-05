# Agent Traces — Design Brief

Brief for a visual design pass. Scope is the **agent trace detail view** only; the list/index view is
out of scope for now.

## Context

Maple is an OpenTelemetry observability platform. This feature reconstructs an agent conversation
from OTel spans emitted by LLM providers and agent frameworks, using the
[GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md).

An **agent trace** is one end-to-end agent conversation: the user's messages, the model's replies, and
everything the agent did in between. Because it comes from spans, every element carries precise
timing — the design should treat time as a first-class dimension, not a footnote.

The data is provider-agnostic by construction: OpenRouter, the Vercel AI SDK, OpenLLMetry, and
vendor SDKs all emit the same attribute shape. Nothing in this view should look provider-specific.

## Layout

An overview header, then a vertically scrolling chronological timeline.

### Overview header

Agent trace-level summary:

- Total wall-clock duration
- Model(s) used — **handle the multi-model case**: an agent trace can hop between models mid-conversation,
  so the "model" slot needs a graceful representation of two or three
- Total tokens consumed, split into input and output
- Total cost
- Turn count
- Success/error state for the agent trace as a whole

### System prompt

Pinned at the top of the timeline, **collapsed by default, expandable**.

It is long — often thousands of words — and read rarely, but read carefully when it is. The
collapsed state should hint at its length. This is reference material, not conversation: it should
read as visually distinct from the messages below it.

### Message timeline

Alternating user and assistant messages in chronological order. Each message carries:

- Timestamp
- Its own duration
- Token count
- (Assistant messages) which model produced it

Timing is the point of this product. The design should make it easy to see **where the time went**,
including gaps of user think-time between turns. Assistant message bodies are markdown and can be
long — consider truncation with expand.

### Tool calls

Inline in the timeline, **nested under the assistant message that triggered them** — one message
often fires several. Each shows:

- Tool name
- Duration
- Success/failure

Arguments and return value are collapsed by default and expandable; both are JSON and sometimes
large.

- Parallel tool calls must read as parallel, not sequential.
- Tool failures must be obvious at a glance, without expanding.

## States to cover

**Content-redacted (critical, and common — not an edge case).** Message bodies are optional in the
standard and are frequently disabled for privacy. OpenRouter's Privacy Mode, for example, strips
exactly the system prompt, inputs, and outputs while keeping all timing, model, token, and cost
data. Design a first-class degraded state where agent trace structure, timing, and metrics are fully
intact but message text is unavailable. It must not look broken.

Also:

- Agent trace still in progress (last message streaming)
- A failed turn where the provider returned an error
- A very long agent trace (100+ turns) needing navigation

## Design for what's coming

These are not in the first cut, but they shape the structure enough that retrofitting is expensive.

**An agent trace isn't only messages.** The standard defines operations beyond `chat`: tool execution,
`retrieval` (RAG lookups, carrying the query text and returned documents), memory operations
(search/update), `plan` for task-decomposition steps, and agent invocation. **The timeline should
admit non-message event types from the start.**

**Multi-agent handoffs.** One agent trace can span several distinct agents delegating to each other
(`gen_ai.agent.name`, `gen_ai.agent.id`, `gen_ai.workflow.name`). Given the feature name, this is
the most important thing to accommodate early — it's the difference between a chat log and a real
agent trace.

## Additional data available

Worth surfacing, roughly in priority order:

| Signal | Why it matters |
| --- | --- |
| Requested vs served model | These can differ; with a router like OpenRouter they often will. Surface the divergence. |
| Cache token breakdown | Cached input tokens are dramatically cheaper — a raw input count misrepresents cost. |
| Reasoning tokens | On reasoning models, invisible thinking tokens can dominate the bill. |
| Finish reason | `stop` vs `length` vs `tool_calls` vs content-filtered. A `length`-truncated response is a silent failure that looks like a normal message — it deserves a badge. |
| Time to first token | Distinct from total duration; it's what matches *perceived* latency. |
| Context compacted flag | The explanation for "why did the agent forget what I told it" — hard to diagnose without it. |
| Prompt name + version | Ties a bad agent trace to a specific prompt version. |
| Sampling parameters | Temperature, top_p, max_tokens, seed, stop sequences, plus the full tool schema offered to the model. All reference material — good candidates for one collapsed "request configuration" panel beside the system prompt, rather than clutter in the timeline. |

## Note on attribute names

The `gen_ai.*` conventions are still marked **Development** in the OTel spec and have already
churned once (`gen_ai.system` → `gen_ai.provider.name`). Design against the semantic roles described
above, not against exact attribute names.
