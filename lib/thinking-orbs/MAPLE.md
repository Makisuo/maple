# `@maple/thinking-orbs` — vendored from `Jakubantalik/thinking-orbs`

This package is a **vendored copy** of `src/` from
[`Jakubantalik/thinking-orbs`](https://github.com/Jakubantalik/thinking-orbs), pinned in
[`UPSTREAM.json`](./UPSTREAM.json) to SHA `e94f207ea122f8cca0aaa6409ab7fe82d55c38f1`. Upstream is MIT
licensed (see [`LICENSE`](./LICENSE)) and does publish to npm as `thinking-orbs`, but that release
ships `dist/` only — no source. At v0.2.0 from a single author, we'd rather read and own the ~1,400
lines than take an opaque prebuilt bundle on the chat hot path, so we vendor the source instead.

Nine canvas-2D loading animations (`working`, `searching`, `solving`, `listening`, `connecting`,
`weaving`, `composing`, `breathing`, `shaping`) at two tuned sizes. No runtime dependencies, no
WebGL, no `ctx.filter`.

## Rules for this directory

- **Do not reformat.** Upstream is prettier-style (2-space indent, semicolons, single quotes); Maple is
  oxfmt (tabs, no semicolons, 110 columns). Reformatting would turn any future upstream sync into a
  whole-file conflict. `lib/thinking-orbs` is therefore in the `ignorePatterns` of `.oxfmtrc.jsonc` and
  `.oxlintrc.json`, and in `ignoreWorkspaces` in `knip.json`.
- **Do not add Maple-specific behaviour here.** The tool→state mapping, the theme wiring and the
  transcript integration live in `apps/web/src/components/ai-elements/`, never inside vendored source.
- There is no sync script (unlike `bun run llm:sync`). This is a leaf library that won't be re-synced on
  a cadence; `UPSTREAM.json` records provenance so a future sync is a deliberate manual diff.

## Delta from upstream

| Change | Why |
| --- | --- |
| `package.json` rewritten | `@maple/thinking-orbs`, `private`, no build step, source-exported via `"exports": { ".": "./src/index.ts" }` like the other `lib/*` packages. Upstream's vite / vite-plugin-dts / tailwind demo tooling is dropped, and the React peer is narrowed from `>=18` to `^19` to match the rest of the workspace. |
| `tsconfig.json` replaced | Copied from `lib/cache` so it typechecks under Maple's toolchain, plus `"jsx": "react-jsx"`. |
| `demo/`, `vite.config*.ts`, `biome.json`, `README.md` dropped | Demo-site and upstream-tooling only. |

## Gotchas at the call site

- **`OrbSize` is the literal union `64 | 20`.** The two presets carry their own dot counts, dot sizes and
  speeds — they are separate designs, not a scale factor. Don't CSS-scale one into the other.
- **Don't use `theme="auto"` in Maple.** `useResolvedDark` in [`src/theme.ts`](./src/theme.ts) installs a
  `MutationObserver` on `document.documentElement` with `subtree: true` watching `class`, which in an app
  this busy fires on unrelated class churn and calls `setDark` on the streaming hot path. Maple has a
  first-class theme store, so `ThinkingOrbIcon` passes `theme` explicitly and the effect early-returns
  before ever constructing the observer.
- Each mounted orb runs its own `requestAnimationFrame` loop, but they share one `performance.now()`
  clock (so they stay in phase) and pause themselves offscreen via `IntersectionObserver` and on
  `visibilitychange`. If a pathological burst ever shows up in profiling, a shared rAF driver is a
  contained change here.
- `prefers-reduced-motion: reduce` is handled inside the component — it paints one static
  representative frame and never starts a loop.
