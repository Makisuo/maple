import { makeExpr } from "../expr"
import { raw, compile } from "../../sql/sql-fragment"
import type { Expr } from "../expr"

// ---------------------------------------------------------------------------
// Date/time functions (handwritten — custom INTERVAL syntax)
// ---------------------------------------------------------------------------

export function toStartOfInterval(
  col: Expr<string>,
  seconds: number | Expr<number>,
): Expr<string> {
  const secStr = typeof seconds === "number" ? String(Math.round(seconds)) : compile((seconds as Expr<number>).toFragment())
  return makeExpr<string>(raw(`toStartOfInterval(${compile(col.toFragment())}, INTERVAL ${secStr} SECOND)`))
}

export function intervalSub(
  col: Expr<string>,
  seconds: number | Expr<number>,
): Expr<string> {
  const secStr = typeof seconds === "number" ? String(Math.round(seconds)) : compile((seconds as Expr<number>).toFragment())
  return makeExpr<string>(raw(`${compile(col.toFragment())} - INTERVAL ${secStr} SECOND`))
}
