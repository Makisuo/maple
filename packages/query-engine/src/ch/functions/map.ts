import { makeCond, makeExpr } from "../expr"
import { raw, str, compile } from "../../sql/sql-fragment"
import type { Expr, Condition } from "../expr"

// ---------------------------------------------------------------------------
// Map functions (handwritten — bracket syntax or custom assembly)
// ---------------------------------------------------------------------------

export function mapContains(
  mapExpr: Expr<Record<string, string>>,
  key: string,
): Condition {
  return makeCond(raw(`mapContains(${compile(mapExpr.toFragment())}, ${compile(str(key))})`))
}

export function mapGet(
  mapExpr: Expr<Record<string, string>>,
  key: string,
): Expr<string> {
  return makeExpr<string>(raw(`${compile(mapExpr.toFragment())}[${compile(str(key))}]`))
}

export function mapLiteral(
  ...pairs: Array<[string, Expr<string>]>
): Expr<Record<string, string>> {
  if (pairs.length === 0) return makeExpr<Record<string, string>>(raw("map()"))
  const args = pairs
    .map(([k, v]) => `${compile(str(k))}, ${compile(v.toFragment())}`)
    .join(", ")
  return makeExpr<Record<string, string>>(raw(`map(${args})`))
}
