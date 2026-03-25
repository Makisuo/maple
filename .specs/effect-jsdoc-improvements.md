## Overview

Improve the JSDoc for `packages/effect/src/Effect.ts` so it is concise, consistent,
and accurate for Effect 4.x. This is a documentation-only pass focused on
clarity, category taxonomy, and example correctness.

## Goals

- Standardize `@category` tags with a consistent naming + casing scheme.
- Tighten summaries to be clear and concise while preserving intent.
- Update or add examples where they are missing, outdated, or unclear.
- Ensure `@since` tags are present and correct for public exports.
- Keep documentation consistent with current Effect idioms

## Non-goals

- No runtime behavior or API changes.
- No changes outside `packages/effect/src/Effect.ts` (other than this spec link).
- No new features, refactors, or type-level changes.

## Constraints

- Do not edit barrel files (`index.ts`) or run `pnpm codegen`.
- Keep existing section markers (`// =====`) unchanged.
- Not all exports require examples. Some type-only exports may only need a
  summary and tags. For reference, see the `Queue.ts` JSDoc for an example of a
  well-documented module. But most exports will need examples.
  **Focus on the exports that developers will use directly**.

## Current Issues (Observed)

- Inconsistent `@category` casing and naming (for example, `Models` vs `models`,
  `Sequencing` vs `sequencing`, `Delays & Timeouts` vs `delays & timeouts`).
- Some summaries are verbose or redundant for well-known combinators.
- Examples vary in style and level of clarity across sections.

## Documentation Approach

### Category taxonomy

- Canonical list (Title Case, use `&` where present today):
  - Caching
  - Clock
  - Collecting
  - Condition Checking
  - Conditional Operators
  - Conversions
  - Converting Failures to Defects
  - Creating Effects
  - Delays & Timeouts
  - Eager
  - Effectify
  - Environment
  - Error Handling
  - Fallback
  - Filtering
  - Function
  - Guards
  - Interruption
  - Latch
  - Logging
  - Mapping
  - Models
  - Outcome Encapsulation
  - Output Encapsulation
  - Pattern Matching
  - Racing
  - References
  - Repetition / Recursion
  - Requests & Batching
  - Resource Management & Finalization
  - Running Effects
  - Semaphore
  - Sequencing
  - ServiceMap
  - Supervision & Fibers
  - Tracing
  - Tracking
  - Transactions
  - Type Constraints
  - Type Lambdas
  - Util
  - Yieldable
  - Zipping
- Normalize duplicates to the canonical name (for example, `Error handling` to
  `Error Handling`, `models` to `Models`).

### Summary + detail format

- First line: one-sentence summary of the behavior.
- Second paragraph (if needed): key behavioral nuance or common usage pattern.
- Avoid repeating obvious type information already expressed in the signature.

### Examples

- Before writable any examples, first understand the export's behavior and
  intended usage by consulting existing tests, docs, and source code.
- Prefer short, runnable snippets that compile with docgen.
- Include comments that clarify how the exported api is used / works.
- There should only be one example per export
- Use `Effect.gen` for sequencing, and only use `Effect.runPromise` when needed to
  demonstrate runtime behavior.
- Prefer `Console.log` over `console.log` when demonstrating effectful logging.
  Any log statements should have a comment indicating expected output.
- Add examples only when missing for widely used or non-obvious combinators, or
  when the existing example is outdated or unclear.
- Any output shown in comments should match actual runtime output (use the
  `scratchpad/` for running examples as needed).
- If you are not showing any output comments, **do not** use any Effect.run* calls
  in the example.

### Tags

- Preserve existing `@since` values unless clearly incorrect.
- When missing, align `@since` with the nearest related export in the same
  section.
- Ensure `@category` is present and normalized.
- Avoid adding `@param` / `@returns` unless the behavior is non-obvious.

## Scope

Audit and update JSDoc for all public exports in `packages/effect/src/Effect.ts`,
including:

- Module header
- Core types and namespaces (`Effect`, `Yieldable`, `All`, etc.)
- Constructors / creation helpers
- Conversions
- Sequencing / mapping / zipping
- Outcome and output encapsulation
- Error handling and failure conversion
- Retries, timeouts, delays
- Environment / services / layers
- Concurrency, fibers, and scheduling

## Acceptance Criteria

- All `@category` tags in `Effect.ts` use a consistent naming and casing scheme.
- Each public export has a concise summary and appropriate tags.
- Examples are consistent in style and compile via `pnpm docgen`.
- No API or runtime behavior changes.
- Section markers and barrel files remain untouched.

## Validation

- `pnpm lint-fix`
- `pnpm test <existing Effect test file>` (if required by workflow)
- `pnpm check`
- `pnpm build`
- `pnpm docgen`
