import { defineFn } from "../define-fn"
import type { Expr } from "../expr"
import * as T from "../types"

export const toJSONString = defineFn<[Expr<any>], string>("toJSONString", T.string)
