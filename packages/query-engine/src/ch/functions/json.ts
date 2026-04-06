import { defineFn } from "../define-fn"
import type { Expr } from "../expr"

export const toJSONString = defineFn<[Expr<any>], string>("toJSONString")
