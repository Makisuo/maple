# Typed Snippet Pipeline

This file captures the planned follow-up work for typed snippets without making
the primary docs renderer depend on a JavaScript markdown pipeline.

## Goals

- Keep the main website build fast.
- Opt into typed snippets on a per-example basis.
- Cache snippet output by content hash so unchanged examples are skipped.
- Allow fallback to plain syntax highlighting when type metadata is not needed.

## Proposed Flow

1. Store typed examples in dedicated snippet files or in fenced code blocks
   marked with an explicit opt-in marker.
2. Run a prebuild script before `zola build` that discovers only those opted-in
   snippets.
3. Hash each snippet together with the relevant TypeScript configuration.
4. If the hash is unchanged, reuse cached rendered output.
5. If the hash changed, run `twoslash-cli` or a focused TypeScript worker to
   produce static HTML and metadata.
6. Write the rendered output into generated partials or adjacent markdown
   includes that Zola can consume as normal static content.

## Why Not In The Main Renderer

- The docs corpus can grow into thousands of pages, so the expensive part needs
  to stay opt-in.
- Typed examples should not make unrelated markdown files slower to render.
- Keeping the TypeScript work in a separate precompute step means the site can
  still be rendered by Zola and deployed as static assets.

## Suggested Cache Key

- Snippet source text
- Snippet language
- `tsconfig.json` contents
- Resolved dependency lockfile hash
- Twoslash or TypeScript tool version

## Fallback Path

If Twoslash proves too expensive or brittle for some categories of examples,
replace the rendering phase with a simpler TypeScript verification step and keep
using Zola's built-in syntax highlighting for the final presentation.
