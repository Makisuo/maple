# MCP eval + catalog baseline

Reference point for judging changes to the MCP tool catalog. Regenerate both halves with the
commands below and append a row; never overwrite history.

## How to regenerate

```bash
# Catalog cost (free, deterministic)
bun run --cwd apps/api measure-tokens

# Eval scores (costs money, needs OPENROUTER_API_KEY)
set -a && . ./.env.local && set +a
cd apps/api && MCP_EVAL_MODEL=moonshotai/kimi-k2.7-code \
  npx vitest run --config vitest.eval.config.ts \
  --reporter=vitest-evals/reporter src/mcp/__evals__
```

Pin `MCP_EVAL_MODEL` explicitly. The default in `model.ts` tracks production and will move,
which makes a later run incomparable to an earlier one.

---

## Baseline — 2026-08-17, commit `3c07fcfe98`

Model: `moonshotai/kimi-k2.7-code` · scope: `src/mcp/__evals__` only.

### Eval scores

| Suite                    | Cases  | Mean score | Threshold |
| ------------------------ | ------ | ---------- | --------- |
| `cli-scenarios.eval.ts`  | 19     | 1.00       | 0.7       |
| `observability.eval.ts`  | 10     | 1.00       | 0.7       |
| `disambiguation.eval.ts` | 5      | 1.00       | 0.7       |
| `execution.eval.ts`      | 1      | 1.00       | 0.7       |
| **Total**                | **35** | **1.00**   | —         |

**These suites are at ceiling.** Every case scores 1.00, so a before/after comparison against
them can only demonstrate _absence of regression_ — it cannot demonstrate improvement. Any
change claiming to make tool selection better must ship a case that fails before it and passes
after. Treat the table above as a guardrail, not a scoreboard.

Unrelated: `src/workflows/__evals__/diagnosis.eval.ts` (investigation diagnosis, a separate
suite) had 7 failures on this commit, including a real crash in
`diagnosis-scorers.ts:108` — `entry.trim is not a function` when a ruled-out entry is not a
string. Not caused by and not blocking MCP work.

**The crash is fixed** — the scorers now treat a present-but-wrong-type field as a zero rather
than trusting the declared type, and the malformed shapes are unit-tested in
`diagnosis-scorers.test.ts`. The suite still fails, and the remaining cause is plumbing, not
reasoning: OpenRouter routes `moonshotai/kimi-k2.7-code` to a provider that returns
`content: null` with the whole answer in `reasoning`, so `generateObject` raises
`AI_NoObjectGeneratedError`; and `createEvalModel()` leaves `supportsStructuredOutputs` at its
`false` default, so the report schema is dropped before the request goes out and the model
free-forms a `{tool_name, tool_input}` envelope that `jsonSchema()` passes through unvalidated.
Fixing that is a change to the shared `mcp/__evals__/model.ts` and would need this table
re-baselined.

### Catalog cost

**57 tools · 17,692 tokens** (`gpt-tokenizer`, name + description + input JSON schema).

Ten most expensive:

| Tool                   | Total | Description | Schema |
| ---------------------- | ----: | ----------: | -----: |
| `create_alert_rule`    |  1314 |          63 |   1248 |
| `create_dashboard`     |  1219 |         820 |    397 |
| `add_dashboard_widget` |  1166 |         287 |    876 |
| `query_data`           |  1021 |          57 |    962 |
| `search_sessions`      |   934 |         144 |    788 |
| `update_alert_rule`    |   924 |          46 |    875 |
| `search_traces`        |   558 |          57 |    498 |
| `inspect_chart_data`   |   440 |         294 |    143 |
| `run_sql`              |   410 |         102 |    306 |
| `mine_log_patterns`    |   402 |          97 |    302 |

The top six are 6,578 tokens — **37% of the catalog**. Note the split: for five of the six the
cost is the **input schema**, not the prose. Only `create_dashboard` is description-dominant.
A diet aimed at descriptions would recover roughly 1k tokens total; the schemas are where the
budget actually goes.

---

## After the MCP audit changes — 2026-08-17

Same model, same scope.

|                       | Before |  After |                   Δ |
| --------------------- | -----: | -----: | ------------------: |
| Tools                 |     57 |     56 |                  −1 |
| Catalog tokens        | 17,692 | 15,225 | **−2,467 (−13.9%)** |
| Eval cases            |     35 |     35 |                   — |
| Reproducible failures |      0 |      0 |                   — |

### Where the 2,467 tokens came from

Almost all of it is one change, and it was a **correctness fix** that happened to pay:
`toInputSchema` now collapses `anyOf: [T, {type: "null"}]` to `T`
(`tools/registry.ts`). `Schema.optional(X)` types as `X | undefined` and rejects an explicit
null, but rendered a JSON `null` branch — so the published schema told every client that
`{"service": null}` was valid on every optional parameter of all 57 tools, while the decoder
answered `Expected string | undefined`. Removing the lie removed 2,268 tokens of union wrapper.

Prose trimming on the five fattest tools, by contrast, recovered **140 tokens**. Descriptions
are 58% of the catalog but they are mostly load-bearing; do not expect a diet to come from there.

### Verdict on tool selection

Two full runs, each with exactly **one** failing case — but a _different_ case each time
("deep health investigation" in the first, "list all the error types" in the second). The first
was then re-run twice in isolation and scored **1.00 both times**.

Both failures share a signature: the model answers with narration ("I'll get the current time
first…") instead of emitting a tool call on the first step. That is model nondeterminism —
`temperature: 0` does not make these runs reproducible — not a regression from the catalog change.

**Read a single failing case here as noise until it fails twice in a row.** A real selection
regression shows up as the same case failing on re-run.

### Deterministic coverage added alongside

Because the LLM suites are at ceiling and individually flaky, the three production bugs this
work fixed are pinned by free, always-on tests instead:

- `__evals__/regression.test.ts` — "agent-recoverable error messages": `error_detail` given a
  truncated issue id / a full UUID / an `alert:` incident id, and `query_data` given a token
  valid only for the other `kind`. These run the real handlers through the real dispatcher.
- `lib/query-spec-tokens.test.ts` — pins the metric/group_by table against the domain schemas
  by decoding, so it cannot drift.
- `tools/registry.test.ts` — pins the invariant the nullable collapse depends on (no MCP
  parameter genuinely accepts null).
