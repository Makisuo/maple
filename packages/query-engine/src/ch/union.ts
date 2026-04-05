// ---------------------------------------------------------------------------
// UNION ALL Query Builder
//
// Combines multiple CHQuery instances with UNION ALL. All sub-queries must
// share the same Output type. Supports optional outer ORDER BY / LIMIT /
// OFFSET wrapping.
// ---------------------------------------------------------------------------

import type { ColumnDefs } from "./types"
import type { CHQuery } from "./query"

// ---------------------------------------------------------------------------
// Union state (runtime)
// ---------------------------------------------------------------------------

export interface CHUnionState {
  readonly queries: ReadonlyArray<CHQuery<any, any, any>>
  readonly outerOrderBySpecs: Array<[string, "asc" | "desc"]>
  readonly outerLimitValue?: number
  readonly outerOffsetValue?: number
  readonly formatValue?: string
}

// ---------------------------------------------------------------------------
// CHUnionQuery interface
// ---------------------------------------------------------------------------

export interface CHUnionQuery<
  Output extends Record<string, any> = {},
  Params extends Record<string, any> = {},
> {
  readonly _tag: "CHUnionQuery"
  /** @internal — runtime union state */
  readonly _state: CHUnionState
  /** phantom */
  readonly _phantom?: { output: Output; params: Params }

  orderBy(
    ...specs: Array<[keyof Output & string, "asc" | "desc"]>
  ): CHUnionQuery<Output, Params>

  limit(n: number): CHUnionQuery<Output, Params>

  offset(n: number): CHUnionQuery<Output, Params>

  format(fmt: "JSON" | "JSONEachRow"): CHUnionQuery<Output, Params>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function makeUnionQuery<
  Output extends Record<string, any>,
  Params extends Record<string, any>,
>(state: CHUnionState): CHUnionQuery<Output, Params> {
  return {
    _tag: "CHUnionQuery" as const,
    _state: state,

    orderBy(...specs) {
      return makeUnionQuery({
        ...state,
        outerOrderBySpecs: specs as Array<[string, "asc" | "desc"]>,
      })
    },

    limit(n) {
      return makeUnionQuery({ ...state, outerLimitValue: n })
    },

    offset(n) {
      return makeUnionQuery({ ...state, outerOffsetValue: n })
    },

    format(fmt) {
      return makeUnionQuery({ ...state, formatValue: fmt })
    },
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function unionAll<
  Output extends Record<string, any>,
  Params extends Record<string, any>,
>(
  ...queries: Array<CHQuery<ColumnDefs, Output, Params>>
): CHUnionQuery<Output, Params> {
  return makeUnionQuery({
    queries,
    outerOrderBySpecs: [],
  })
}
