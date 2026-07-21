import type { Expr } from "@maple-dev/clickhouse-builder/expr"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { compile } from "@maple-dev/clickhouse-builder/sql"

/**
 * Canonical operation-name expression shared by runtime queries and generated
 * trace rollup SQL. HTTP server spans become `METHOD /route`; every other span,
 * including internal operations, keeps its original name.
 */
export function normalizedSpanNameExpr(
	spanName: Expr<string>,
	route: Expr<string>,
	urlPath: Expr<string>,
): Expr<string> {
	return CH.if_(
		spanName
			.like("http.server %")
			.or(spanName.in_("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"))
			.and(route.neq("").or(urlPath.neq(""))),
		CH.concat(
			CH.if_(spanName.like("http.server %"), CH.replaceOne(spanName, "http.server ", ""), spanName),
			CH.lit(" "),
			CH.if_(route.neq(""), route, urlPath),
		),
		spanName,
	)
}

const spanAttributes = CH.dynamicColumn<Record<string, string>>("SpanAttributes")

/** SQL text required by Tinybird materialization and ClickHouse migration DDL. */
export const NORMALIZED_SPAN_NAME_SQL = compile(
	normalizedSpanNameExpr(
		CH.dynamicColumn<string>("SpanName"),
		CH.mapGet(spanAttributes, "http.route"),
		CH.mapGet(spanAttributes, "url.path"),
	).toFragment(),
)
