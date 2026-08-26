import { makeExpr, toFragment } from "../expr"
import { compile, raw } from "../../sql/sql-fragment"
import type { Expr } from "../expr"
import { schemaOf } from "../define-fn"
import { QueryBuilderError } from "../errors"

export type WindowOrderDirection = "asc" | "desc"

export type WindowFrameBound =
	| { readonly type: "CurrentRow" }
	| { readonly type: "UnboundedPreceding" }
	| { readonly type: "UnboundedFollowing" }
	| { readonly type: "Preceding"; readonly value: number | Expr<number> }
	| { readonly type: "Following"; readonly value: number | Expr<number> }

export interface WindowRowsFrame {
	readonly type: "RowsBetween"
	readonly start: WindowFrameBound
	readonly end: WindowFrameBound
}

export interface WindowSpec {
	readonly partitionBy?: readonly Expr<any>[]
	readonly orderBy?: readonly Readonly<[Expr<any>, WindowOrderDirection]>[]
	readonly frame?: WindowRowsFrame
}

export interface CompiledWindowSpec {
	readonly _brand: "WindowSpec"
	readonly sql: string
}

export const currentRow: WindowFrameBound = { type: "CurrentRow" }
export const unboundedPreceding: WindowFrameBound = { type: "UnboundedPreceding" }
export const unboundedFollowing: WindowFrameBound = { type: "UnboundedFollowing" }

export function preceding(value: number | Expr<number>): WindowFrameBound {
	return { type: "Preceding", value }
}

export function following(value: number | Expr<number>): WindowFrameBound {
	return { type: "Following", value }
}

export function rowsBetween(start: WindowFrameBound, end: WindowFrameBound): WindowRowsFrame {
	return { type: "RowsBetween", start, end }
}

export function windowSpec(spec: WindowSpec): CompiledWindowSpec {
	const parts: string[] = []

	if (spec.partitionBy && spec.partitionBy.length > 0) {
		parts.push(`PARTITION BY ${spec.partitionBy.map((expr) => compile(expr.toFragment())).join(", ")}`)
	}

	if (spec.orderBy && spec.orderBy.length > 0) {
		const orderBy = spec.orderBy
			.map(([expr, direction]) => `${compile(expr.toFragment())} ${direction.toUpperCase()}`)
			.join(", ")
		parts.push(`ORDER BY ${orderBy}`)
	}

	if (spec.frame) parts.push(compileRowsFrame(spec.frame))

	// Same class as `windowFunnel`'s empty condition list: `partitionBy` is
	// routinely built from a grouping key list, so an empty spec can be data.
	if (parts.length === 0) {
		throw new QueryBuilderError({
			code: "InvalidArguments",
			message: "windowSpec requires at least one of partitionBy, orderBy or frame",
		})
	}

	return { _brand: "WindowSpec", sql: parts.join(" ") }
}

export function over<T>(expr: Expr<T>, spec: CompiledWindowSpec): Expr<T> {
	// A window changes which rows feed the value, never how the value decodes.
	return makeExpr(raw(`${compile(expr.toFragment())} OVER (${spec.sql})`), schemaOf<T>(expr))
}

export function lagInFrame<T>(
	expr: Expr<T>,
	offset: number | Expr<number>,
	defaultValue: T | Expr<T>,
): Expr<T> {
	return makeExpr(
		raw(
			`lagInFrame(${compile(expr.toFragment())}, ${compile(toFragment(offset))}, ${compile(toFragment(defaultValue))})`,
		),
		schemaOf<T>(expr),
	)
}

function compileRowsFrame(frame: WindowRowsFrame): string {
	return `ROWS BETWEEN ${compileFrameBound(frame.start)} AND ${compileFrameBound(frame.end)}`
}

function compileFrameBound(bound: WindowFrameBound): string {
	switch (bound.type) {
		case "CurrentRow":
			return "CURRENT ROW"
		case "UnboundedPreceding":
			return "UNBOUNDED PRECEDING"
		case "UnboundedFollowing":
			return "UNBOUNDED FOLLOWING"
		case "Preceding":
			return `${compile(toFragment(bound.value))} PRECEDING`
		case "Following":
			return `${compile(toFragment(bound.value))} FOLLOWING`
	}
}
