# `@maple/llm` — vendored from `anomalyco/opencode`

This package is a **vendored copy** of `packages/llm` from
[`anomalyco/opencode`](https://github.com/anomalyco/opencode), pinned in [`UPSTREAM.json`](./UPSTREAM.json)
to SHA `32f278b48f1a495611165d8a9f1ace0b512933e2`. Upstream is MIT licensed (see [`LICENSE`](./LICENSE))
and unpublished (`private: true`), so there is no npm release to depend on and no semver contract — hence
the vendor.

## Rules for this directory

- **Do not reformat.** Upstream is prettier-style (2-space indent, no semicolons, 120 columns); Maple is
  oxfmt (tabs, 110 columns). Reformatting would turn every future upstream sync into a whole-file conflict.
  `lib/llm` is therefore in the `ignorePatterns` of `.oxfmtrc.jsonc` and `.oxlintrc.json`, and in
  `ignoreWorkspaces` in `knip.json`.
- **Do not add Maple-specific behaviour here.** Layers, observability attributes, tenant scoping and error
  mapping belong at the Maple call site (`apps/api/src/platform/Llm.ts`), never inside vendored source.
- Re-sync with `bun run llm:sync` (`--check` in CI); see [`scripts/sync-llm-upstream.ts`](../../scripts/sync-llm-upstream.ts).

## Delta from upstream

| Change | Why |
| --- | --- |
| `src/schema/opencode-llm.ts` added; `src/schema/ids.ts` and `src/schema/messages.ts` import from it instead of `@opencode-ai/schema/llm` | Drops a whole second unpublished workspace package from the sync surface. The dependency was 5 symbols in 2 files; the file inlines `opencode/packages/schema/src/llm.ts` verbatim plus the `optional` helper it pulls from `opencode/packages/schema/src/schema.ts`. |
| `src/schema/errors.ts` uses `Schema.TaggedError`; `src/protocols/shared.ts` maps `SseError` into `LLMError` | Keeps the vendored core compatible with Maple's pinned Effect v4 beta: `TaggedErrorClass` was replaced by `TaggedError`, and the SSE decoder now exposes a typed `SseError` that must be normalized at the package boundary. |
| `package.json` rewritten | `@maple/llm`, `private`, no build step, source exports, `effect: "catalog:effect"`, vitest instead of `bun test`. Upstream's `@opencode-ai/http-recorder`, `@effect/platform-node`, `@clack/prompts`, `@tsconfig/bun` and `@typescript/native-preview` dev deps are dropped. |
| `tsconfig.json` replaced | Copied from `packages/query-engine` so it typechecks under Maple's toolchain rather than `@tsconfig/bun`. |
| Upstream's `AGENTS.md` renamed to `UPSTREAM-AGENTS.md` | Left as `AGENTS.md` it would load as directory-scoped agent instructions inside Maple while pointing at `packages/opencode/**` paths that don't exist here, and telling agents to run `bun test`. The content is still worth reading — the Effect conventions in it are the ones this source follows. |
| `example/`, `script/`, `sst-env.d.ts` dropped | Bun / `@clack/prompts` / SST specific; they do not belong in Maple. |
| `src/protocols/openai-chat.ts`: `OpenAIChatUsage` gains optional `cost` | OpenRouter's usage accounting (`usage: {include: true}`) returns the call's credit cost in the usage object; the closed struct silently dropped it. Provider-generic (documented OpenRouter API, inert for plain OpenAI), flows out through the existing `providerMetadata.openai` escape hatch — no `Usage` contract change. Candidate to upstream. |
| `test/` ported from `bun:test` to vitest, and the `@opencode-ai/http-recorder` harness replaced by `test/lib/replay.ts` | Maple runs vitest via turbo. The replay layer is a plain `HttpClient` layer over the cassettes in `test/fixtures/recordings`, which also removes the last Node-only dependency. |

The `sst-env.d.ts` drop means upstream's `Resource` typings are gone — nothing in `src/` referenced them.
