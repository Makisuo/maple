// ---------------------------------------------------------------------------
// Query Parameters
//
// Params are placeholder expressions whose values are resolved at compile
// time (not at SQL execution time). They carry their name and type as
// phantom types so the query's Params type can be inferred.
//
// At compile time, the param proxy resolves each param name from the
// provided params object and produces a literal Expr (str/int).
// ---------------------------------------------------------------------------

import type { SqlFragment } from "../sql/sql-fragment"
import { raw, str } from "../sql/sql-fragment"
import type { Expr } from "./expr"

// ---------------------------------------------------------------------------
// Param marker — used during query definition (before compilation)
// ---------------------------------------------------------------------------

export interface ParamMarker<N extends string, T> extends Expr<T> {
  readonly _paramName: N
  readonly _paramType?: T
}

function makeParamMarker<N extends string, T>(name: N, fragment: SqlFragment): ParamMarker<N, T> {
  // At definition time, toFragment() returns a placeholder.
  // At compile time, the param proxy replaces it with the real value.
  return {
    _brand: "Expr" as const,
    _paramName: name,
    toFragment: () => fragment,

    // Comparison/arithmetic methods delegate to the base Expr
    eq: () => { throw new Error(`Param '${name}' not resolved — compile the query first`) },
    neq: () => { throw new Error(`Param '${name}' not resolved`) },
    gt: () => { throw new Error(`Param '${name}' not resolved`) },
    gte: () => { throw new Error(`Param '${name}' not resolved`) },
    lt: () => { throw new Error(`Param '${name}' not resolved`) },
    lte: () => { throw new Error(`Param '${name}' not resolved`) },
    like: () => { throw new Error(`Param '${name}' not resolved`) },
    notLike: () => { throw new Error(`Param '${name}' not resolved`) },
    div: () => { throw new Error(`Param '${name}' not resolved`) },
    mul: () => { throw new Error(`Param '${name}' not resolved`) },
    add: () => { throw new Error(`Param '${name}' not resolved`) },
    sub: () => { throw new Error(`Param '${name}' not resolved`) },
  } as ParamMarker<N, T>
}

// ---------------------------------------------------------------------------
// Param constructors (used in query definitions)
// ---------------------------------------------------------------------------

export const param = {
  string: <N extends string>(name: N): ParamMarker<N, string> =>
    makeParamMarker(name, raw(`__PARAM_${name}__`)),

  int: <N extends string>(name: N): ParamMarker<N, number> =>
    makeParamMarker(name, raw(`__PARAM_${name}__`)),

  dateTime: <N extends string>(name: N): ParamMarker<N, string> =>
    makeParamMarker(name, raw(`__PARAM_${name}__`)),
}

// ---------------------------------------------------------------------------
// Resolved param values — produced at compile time
// ---------------------------------------------------------------------------

export function resolveParamValue(_name: string, value: unknown): SqlFragment {
  if (typeof value === "string") return str(value)
  if (typeof value === "number") return raw(String(Math.round(value)))
  if (typeof value === "boolean") return raw(value ? "1" : "0")
  return raw(String(value))
}

// ---------------------------------------------------------------------------
// Type-level utilities for collecting param types from a query
// ---------------------------------------------------------------------------

export type ExtractParams<T> =
  T extends ParamMarker<infer N, infer V>
    ? { [K in N]: V }
    : T extends Expr<any>
      ? {}
      : T extends Record<string, any>
        ? UnionToIntersection<{ [K in keyof T]: ExtractParams<T[K]> }[keyof T]>
        : {}

type UnionToIntersection<U> =
  (U extends any ? (k: U) => void : never) extends (k: infer I) => void
    ? I
    : never
