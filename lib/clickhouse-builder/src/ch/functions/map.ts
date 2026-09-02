import { makeCond, makeExpr } from "../expr"
import { raw, str, compile } from "../../sql/sql-fragment"
import type { Expr, Condition } from "../expr"
import * as T from "../types"

const STRINGS = T.array(T.string).schema
const STRING_MAP = T.map(T.string, T.string).schema

// Map functions (handwritten — bracket syntax or custom assembly)

export function mapContains(mapExpr: Expr<Record<string, string>>, key: string): Condition {
	return makeCond(raw(`mapContains(${compile(mapExpr.toFragment())}, ${compile(str(key))})`))
}

export function mapGet(mapExpr: Expr<Record<string, string>>, key: string): Expr<string> {
	return makeExpr(raw(`${compile(mapExpr.toFragment())}[${compile(str(key))}]`), T.string.schema)
}

export function mapKeys(mapExpr: Expr<Record<string, string>>): Expr<ReadonlyArray<string>> {
	return makeExpr(raw(`mapKeys(${compile(mapExpr.toFragment())})`), STRINGS)
}

export function mapValues(mapExpr: Expr<Record<string, string>>): Expr<ReadonlyArray<string>> {
	return makeExpr(raw(`mapValues(${compile(mapExpr.toFragment())})`), STRINGS)
}

/**
 * `mapFilter((k, v) -> <predicate>, map)` — the entries whose KEY passes.
 *
 * The predicate is built from the lambda's key parameter, so it can use every
 * condition the DSL has (`in_`, `like`, `or`, …). Values are not inspected.
 */
export function mapFilterKeys(
	mapExpr: Expr<Record<string, string>>,
	predicate: (key: Expr<string>) => Condition,
): Expr<Record<string, string>> {
	const key = makeExpr(raw("k"), T.string.schema)
	return makeExpr(
		raw(`mapFilter((k, v) -> ${compile(predicate(key).toFragment())}, ${compile(mapExpr.toFragment())})`),
		STRING_MAP,
	)
}

export function mapLiteral(...pairs: Array<[string, Expr<string>]>): Expr<Record<string, string>> {
	if (pairs.length === 0) return makeExpr(raw("map()"), STRING_MAP)
	const args = pairs.map(([k, v]) => `${compile(str(k))}, ${compile(v.toFragment())}`).join(", ")
	return makeExpr(raw(`map(${args})`), STRING_MAP)
}
