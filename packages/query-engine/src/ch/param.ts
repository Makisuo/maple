// ---------------------------------------------------------------------------
// Query Parameters
//
// Params are placeholder expressions whose values are resolved at compile
// time (not at SQL execution time). They carry their name and type as
// phantom types so the query's Params type can be inferred.
// ---------------------------------------------------------------------------

import type { SqlFragment } from "../sql/sql-fragment"
import { raw } from "../sql/sql-fragment"
import type { Expr } from "./expr"
import { QueryBuilderError } from "./compile"

// ---------------------------------------------------------------------------
// Param marker — used during query definition (before compilation)
// ---------------------------------------------------------------------------

export interface ParamMarker<N extends string, T> extends Expr<T> {
  readonly _paramName: N
  readonly _paramType?: T
}

function makeParamMarker<N extends string, T>(name: N, fragment: SqlFragment): ParamMarker<N, T> {
  return {
    _brand: "Expr" as const,
    _paramName: name,
    toFragment: () => fragment,
    eq: () => { throw new QueryBuilderError({ code: "UnresolvedParam", message: `Param '${name}' not resolved — compile the query first` }) },
    neq: () => { throw new QueryBuilderError({ code: "UnresolvedParam", message: `Param '${name}' not resolved` }) },
    gt: () => { throw new QueryBuilderError({ code: "UnresolvedParam", message: `Param '${name}' not resolved` }) },
    gte: () => { throw new QueryBuilderError({ code: "UnresolvedParam", message: `Param '${name}' not resolved` }) },
    lt: () => { throw new QueryBuilderError({ code: "UnresolvedParam", message: `Param '${name}' not resolved` }) },
    lte: () => { throw new QueryBuilderError({ code: "UnresolvedParam", message: `Param '${name}' not resolved` }) },
    like: () => { throw new QueryBuilderError({ code: "UnresolvedParam", message: `Param '${name}' not resolved` }) },
    notLike: () => { throw new QueryBuilderError({ code: "UnresolvedParam", message: `Param '${name}' not resolved` }) },
    ilike: () => { throw new QueryBuilderError({ code: "UnresolvedParam", message: `Param '${name}' not resolved` }) },
    div: () => { throw new QueryBuilderError({ code: "UnresolvedParam", message: `Param '${name}' not resolved` }) },
    mul: () => { throw new QueryBuilderError({ code: "UnresolvedParam", message: `Param '${name}' not resolved` }) },
    add: () => { throw new QueryBuilderError({ code: "UnresolvedParam", message: `Param '${name}' not resolved` }) },
    sub: () => { throw new QueryBuilderError({ code: "UnresolvedParam", message: `Param '${name}' not resolved` }) },
    in_: () => { throw new QueryBuilderError({ code: "UnresolvedParam", message: `Param '${name}' not resolved` }) },
    notIn: () => { throw new QueryBuilderError({ code: "UnresolvedParam", message: `Param '${name}' not resolved` }) },
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
