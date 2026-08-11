// Compiles the AI-vendor registry to ClickHouse expressions over a `traces` row.
//
// Two consumers justify this existing at all:
//
//  1. **Equivalence testing.** The Rust detector in `apps/ingest` classifies at write time. These
//     expressions re-derive the same answer from the row it wrote, so a differential test can
//     compare the two over real captures (plan §6). SQL text that merely *looks* right is not the
//     contract — the analyzer is, which is why `./compile-sql.clickhouse.e2e.test.ts` runs the
//     output through a real ClickHouse.
//  2. **Rebuilds.** When a registry fix means "previously unclassified spans now classify", the
//     rollup rebuild job (plan §4) recomputes `service_ai_vendors_hourly` from raw rows. It cannot
//     use the stored `AiVendor` — that is the column being fixed — so it needs the rules as SQL.
//
// **No hash SQL is emitted — a scope boundary, not a constraint.** `AiSessionKeyHash` is
// `cityHash64(value)` over the winning candidate's raw value, which `sessionKeyValueExpr` already
// exposes, so wrapping it is a one-liner any caller can write and the equivalence suite's SQL leg
// does exactly that. It is not emitted here because nothing in v1 consumes it: the rollup rebuild
// job is deferred with the rest of the read path. Note that plan §4 declares `SessionsApprox` **not
// rebuildable** when a registry fix changes which candidate wins — that does not hold here. The
// rebuild can recompute the hash from the value this compiler already exposes, and
// `hash-alignment.clickhouse.e2e.test.ts` proves ClickHouse's `cityHash64` returns exactly what the
// ingest writer wrote, so recomputed hashes merge with MV-written ones. The real limit on a rebuild
// is the raw horizon: `traces` keeps 30 days and this rollup keeps 400.
//
// ## Predicate targeting
//
// The pseudo-keys `scope.name` / `span.name` / `scope.version` / `scope.schema_url` are real
// columns and always resolve to those columns, whatever class the matcher carries — `effect_ai`'s
// attr matchers key on `span.name`, so class-only targeting would silently never fire. Every other
// key resolves to one map, chosen by matcher class: `resource` → ResourceAttributes,
// `scope` → ScopeAttributes, `attr` → SpanAttributes. Predicates with no class (session-candidate
// authority predicates, candidate key lookups, unknown-tier fingerprints) are span-local and read
// SpanAttributes.
//
// This is the **shared** semantics: `apps/ingest/src/ai_classifier.rs` resolves matchers the same
// way, and the differential suites in this directory hold the two to it (0 pinned divergences).
//
// The outlier is trace-capture's `scripts/verify-seed.ts`, whose `lookup()` falls back
// span → scope → resource for every key regardless of class and unions all three attribute lists
// as `key_prefix` evidence. It keeps that fallback, in its own repo: it verifies one seed at a
// time, where a cross-class read cannot promote some *other* vendor. Here it could, and did —
// `langsmith.internal_provider` is langchain's insufficient resource key and also sits inside
// langchain's attr-class `key_prefix('langsmith.')`, so under the fallback the resource attribute
// alone satisfied the attr matcher, which promotes, and every span of that process — plain HTTP
// included, value ignored — classified `langchain`. Class-directed targeting is what makes plan
// §1's sufficiency gate ("an insufficient resource match contributes no hit on its own") hold.
// The capture corpus is insensitive to the difference: all 10,091 corpus spans classify
// identically under either rule, so no golden depends on the fallback.
//
// ## Presence
//
// `present` compiles to `mapContains`, never `!= ''`. Present-but-empty must stay distinguishable
// from absent — session-key state 4 ("key present but failed validation") exists precisely to
// separate them, and `!= ''` would collapse it into state 3.
//
// ## Why the expressions must be layered in subqueries
//
// The session expressions reference the computed vendor and state by SELECT alias. ClickHouse's
// analyzer **inlines** an alias at every reference rather than evaluating it once, so putting all
// three in one flat SELECT expands `sessionStateExpr` (which references the vendor alias 21 times)
// into `sessionKeyValueExpr` (which references the state alias once per candidate) and the query
// tree passes the 500k-node limit — `Query tree is too big`, measured on the real registry against
// ClickHouse 26.7, not theorised. `renderAiRegistrySelect` therefore emits three nested SELECTs:
// across a subquery boundary an alias is a real output column, so each expression is built once.
// Callers assembling the SQL themselves must preserve that layering.

import { aiRegistry } from "./schema"
import type { AiRegistryDocument, Predicate, SessionCandidate, Vendor } from "./schema"
import { AI_SESSION_KEY_STATE } from "./schema"

/** Column names on the row the expressions read. Overridable for shadow/staging tables. */
export interface AiRegistrySqlColumns {
	readonly spanAttributes: string
	readonly scopeAttributes: string
	readonly resourceAttributes: string
	readonly spanName: string
	readonly scopeName: string
	readonly scopeVersion: string
	readonly scopeSchemaUrl: string
}

export const DEFAULT_AI_REGISTRY_SQL_COLUMNS: AiRegistrySqlColumns = {
	spanAttributes: "SpanAttributes",
	scopeAttributes: "ScopeAttributes",
	resourceAttributes: "ResourceAttributes",
	spanName: "SpanName",
	scopeName: "ScopeName",
	scopeVersion: "ScopeVersion",
	scopeSchemaUrl: "ScopeSchemaUrl",
}

export interface CompileAiRegistrySqlOptions {
	readonly columns?: Partial<AiRegistrySqlColumns>
	/**
	 * SELECT alias the session expressions reference for the computed vendor. It must be the
	 * *computed* vendor, not the stored `AiVendor` column — a rebuild exists because the stored
	 * value is wrong.
	 */
	readonly vendorAlias?: string
	/** SELECT alias for the computed session state, referenced by `sessionKeyValueExpr`. */
	readonly sessionStateAlias?: string
}

export interface CompiledAiRegistrySql {
	/** Resolves to the vendor slug, an `unknown:*` bucket, or `''` for non-AI. */
	readonly vendorExpr: string
	/** Resolves to the `AiSessionKeyState` ladder value. References `vendorAlias`. */
	readonly sessionStateExpr: string
	/**
	 * The winning candidate's raw session-key value, or `''` below state 5. References both
	 * aliases. Never hashed here — see the module header.
	 */
	readonly sessionKeyValueExpr: string
	/** `registry_version`, written to `traces.AiRulesVersion`. */
	readonly rulesVersion: number
	/** The same value as a typed SQL literal. */
	readonly rulesVersionExpr: string
	readonly columns: AiRegistrySqlColumns
	readonly vendorAlias: string
	readonly sessionStateAlias: string
}

/** ClickHouse single-quoted string literal. Backslash first, or the quote escape is re-escaped. */
export const quoteSqlString = (value: string): string =>
	`'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

type AttributeTarget = "span" | "scope" | "resource"

const targetColumn = (target: AttributeTarget, columns: AiRegistrySqlColumns): string =>
	target === "span"
		? columns.spanAttributes
		: target === "scope"
			? columns.scopeAttributes
			: columns.resourceAttributes

const targetForClass = (matcherClass: string): AttributeTarget => {
	if (matcherClass === "resource") return "resource"
	if (matcherClass === "scope") return "scope"
	if (matcherClass === "attr") return "span"
	// `event` / `event_attr` are reserved in the schema and unimplemented in v1 (plan §1). Failing
	// here is the point: a registry that starts using them must not compile to expressions that
	// quietly ignore the rule.
	throw new Error(`ai-registry: matcher class '${matcherClass}' is not implemented in v1`)
}

const pseudoKeyColumn = (key: string, columns: AiRegistrySqlColumns): string | undefined => {
	switch (key) {
		case "scope.name":
			return columns.scopeName
		case "span.name":
			return columns.spanName
		case "scope.version":
			return columns.scopeVersion
		case "scope.schema_url":
			return columns.scopeSchemaUrl
		default:
			return undefined
	}
}

/** `mapContains`, or `1` for a pseudo-key: a real column is always "present" (possibly empty). */
const presenceExpr = (key: string, target: AttributeTarget, columns: AiRegistrySqlColumns): string =>
	pseudoKeyColumn(key, columns) !== undefined
		? "1"
		: `mapContains(${targetColumn(target, columns)}, ${quoteSqlString(key)})`

/** The canonical string value of `key`, as either a real column or a map lookup. */
const valueExpr = (key: string, target: AttributeTarget, columns: AiRegistrySqlColumns): string =>
	pseudoKeyColumn(key, columns) ?? `${targetColumn(target, columns)}[${quoteSqlString(key)}]`

export const compilePredicateSql = (
	predicate: Predicate,
	target: AttributeTarget,
	columns: AiRegistrySqlColumns = DEFAULT_AI_REGISTRY_SQL_COLUMNS,
): string => {
	switch (predicate.op) {
		case "present":
			return presenceExpr(predicate.key, target, columns)
		case "eq": {
			const literal = quoteSqlString(predicate.value)
			const pseudo = pseudoKeyColumn(predicate.key, columns)
			if (pseudo !== undefined) return `${pseudo} = ${literal}`
			// `mapContains` is redundant for a non-empty literal but load-bearing for `eq(key, '')`,
			// where a missing key also reads as `''`.
			return `(${valueExpr(predicate.key, target, columns)} = ${literal} AND ${presenceExpr(predicate.key, target, columns)})`
		}
		case "key_prefix":
			return `arrayExists(k -> startsWith(k, ${quoteSqlString(predicate.prefix)}), mapKeys(${targetColumn(target, columns)}))`
		case "value_prefix":
			// Restricted to pseudo-keys by the algebra (D1), so this is always a real column.
			return `startsWith(${valueExpr(predicate.key, target, columns)}, ${quoteSqlString(predicate.prefix)})`
	}
}

const anyOf = (conditions: ReadonlyArray<string>): string =>
	conditions.length === 1 ? (conditions[0] as string) : `(${conditions.join(" OR ")})`

const compileAuthoritySql = (
	candidate: SessionCandidate,
	columns: AiRegistrySqlColumns,
): string | undefined => {
	const authority = candidate.authority_predicate
	if (authority === null) return undefined // every span of this vendor is authoritative
	if ("any_of" in authority)
		return anyOf(authority.any_of.map((predicate) => compilePredicateSql(predicate, "span", columns)))
	return compilePredicateSql(authority, "span", columns)
}

interface VendorBranch {
	readonly priority: number
	readonly vendor: string
	readonly condition: string
}

const collectVendorBranches = (
	registry: AiRegistryDocument,
	columns: AiRegistrySqlColumns,
): ReadonlyArray<VendorBranch> => {
	const branches: VendorBranch[] = []

	for (const vendor of registry.vendors) {
		const attrConditions = vendor.matchers
			.filter((matcher) => matcher.class === "attr")
			.map((matcher) => compilePredicateSql(matcher.predicate, "span", columns))

		for (const matcher of vendor.matchers) {
			const condition = compilePredicateSql(matcher.predicate, targetForClass(matcher.class), columns)
			if (matcher.sufficient || matcher.class === "attr") {
				// Unconditional hit at its own priority.
				branches.push({ priority: matcher.priority, vendor: vendor.vendor, condition })
				continue
			}
			// The promotion rule: an insufficient resource/scope match is a conditional candidate,
			// promoted only if the same span independently produces an attr hit for the SAME vendor.
			// Without an attr matcher there is nothing that could ever promote it, so emitting the
			// branch would classify Spring Boot's plain HTTP POSTs as spring_ai — the negative case
			// plan §2 names explicitly.
			if (attrConditions.length === 0) continue
			branches.push({
				priority: matcher.priority,
				vendor: vendor.vendor,
				condition: `(${condition} AND ${anyOf(attrConditions)})`,
			})
		}
	}

	for (const rule of registry.unknown_tier)
		branches.push({
			priority: rule.priority,
			vendor: rule.bucket,
			condition: compilePredicateSql(rule.predicate, "span", columns),
		})

	// Descending global priority — the same order the Rust resolver walks. Priorities are unique
	// (asserted in `./validate`), so this sort is total and the output is deterministic.
	return [...branches].sort((left, right) => right.priority - left.priority)
}

/** One level of nesting, so a generated expression stays readable when a human has to debug it. */
const indent = (sql: string): string => sql.split("\n").join("\n\t")

const multiIf = (pairs: ReadonlyArray<readonly [string, string]>, fallback: string): string => {
	if (pairs.length === 0) return fallback
	const body = pairs.map(([condition, result]) => `\t${indent(condition)}, ${indent(result)}`).join(",\n")
	return `multiIf(\n${body},\n\t${indent(fallback)}\n)`
}

/**
 * Per-candidate state, exactly the ladder in `AI_SESSION_KEY_STATE`:
 * not authoritative → 2, key absent → 3, present but invalid → 4, else 6 at session granularity
 * and 5 at run/user/instance.
 */
const compileCandidateStateSql = (
	candidate: SessionCandidate,
	vendor: Vendor,
	columns: AiRegistrySqlColumns,
): string => {
	const pairs: Array<readonly [string, string]> = []

	const authority = compileAuthoritySql(candidate, columns)
	if (authority !== undefined)
		pairs.push([`NOT (${authority})`, String(AI_SESSION_KEY_STATE.notAuthoritative)])

	const presence = presenceExpr(candidate.key, "span", columns)
	if (presence !== "1") pairs.push([`NOT ${presence}`, String(AI_SESSION_KEY_STATE.keyAbsent)])

	const value = valueExpr(candidate.key, "span", columns)
	const invalid: string[] = []
	if (candidate.validation.includes("non_empty")) invalid.push(`${value} = ''`)
	if (candidate.validation.includes("not_in_decoy_values") && vendor.decoy_values.length > 0)
		invalid.push(
			`${value} IN (${vendor.decoy_values.map((decoy) => quoteSqlString(decoy.value)).join(", ")})`,
		)
	if (invalid.length > 0) pairs.push([anyOf(invalid), String(AI_SESSION_KEY_STATE.keyInvalid)])

	const resolved = String(
		candidate.granularity === "session" ? AI_SESSION_KEY_STATE.session : AI_SESSION_KEY_STATE.subSession,
	)
	return multiIf(pairs, resolved)
}

/** `max` over candidates — a monotone quality order, so the reduction is order-independent. */
const compileVendorStateSql = (vendor: Vendor, columns: AiRegistrySqlColumns): string => {
	const states = vendor.session_candidates.map((candidate) =>
		compileCandidateStateSql(candidate, vendor, columns),
	)
	if (states.length === 1) return states[0] as string
	return `greatest(\n${states.map((state) => `\t${indent(state)}`).join(",\n")}\n)`
}

/**
 * The winning candidate's raw value: the first candidate, in declaration order, whose state equals
 * the reduced state — which is exactly "hash from the candidate that produced the winning state,
 * ties broken by candidate order". Empty below state 5, where no hash is written.
 */
const compileVendorKeyValueSql = (
	vendor: Vendor,
	columns: AiRegistrySqlColumns,
	sessionStateAlias: string,
): string => {
	const pairs = vendor.session_candidates.map(
		(candidate) =>
			[
				`${compileCandidateStateSql(candidate, vendor, columns)} = ${sessionStateAlias}`,
				valueExpr(candidate.key, "span", columns),
			] as const,
	)
	return `if(${sessionStateAlias} >= ${AI_SESSION_KEY_STATE.subSession}, ${multiIf(pairs, "''")}, '')`
}

export const compileAiRegistrySql = (
	registry: AiRegistryDocument = aiRegistry,
	options: CompileAiRegistrySqlOptions = {},
): CompiledAiRegistrySql => {
	const columns: AiRegistrySqlColumns = { ...DEFAULT_AI_REGISTRY_SQL_COLUMNS, ...options.columns }
	const vendorAlias = options.vendorAlias ?? "AiVendorComputed"
	const sessionStateAlias = options.sessionStateAlias ?? "AiSessionKeyStateComputed"

	const vendorExpr = multiIf(
		collectVendorBranches(registry, columns).map(
			(branch) => [branch.condition, quoteSqlString(branch.vendor)] as const,
		),
		"''",
	)

	// Only vendors with candidates get a branch. Everything else falls through to "no vendor" (0)
	// or "vendor has no session-key rules" (1) — the latter covers every `unknown:*` bucket.
	const vendorsWithCandidates = registry.vendors.filter((vendor) => vendor.session_candidates.length > 0)
	const noRulesFallback = `if(${vendorAlias} = '', ${AI_SESSION_KEY_STATE.notExamined}, ${AI_SESSION_KEY_STATE.noRules})`

	const sessionStateExpr = multiIf(
		vendorsWithCandidates.map(
			(vendor) =>
				[
					`${vendorAlias} = ${quoteSqlString(vendor.vendor)}`,
					compileVendorStateSql(vendor, columns),
				] as const,
		),
		noRulesFallback,
	)

	const sessionKeyValueExpr = multiIf(
		vendorsWithCandidates.map(
			(vendor) =>
				[
					`${vendorAlias} = ${quoteSqlString(vendor.vendor)}`,
					compileVendorKeyValueSql(vendor, columns, sessionStateAlias),
				] as const,
		),
		"''",
	)

	return {
		vendorExpr,
		sessionStateExpr,
		sessionKeyValueExpr,
		rulesVersion: registry.registry_version,
		rulesVersionExpr: `toUInt32(${registry.registry_version})`,
		columns,
		vendorAlias,
		sessionStateAlias,
	}
}

/** Output aliases of the two expressions that are not already named by `CompiledAiRegistrySql`. */
export const AI_REGISTRY_SESSION_KEY_VALUE_ALIAS = "AiSessionKeyValueComputed"
export const AI_REGISTRY_RULES_VERSION_ALIAS = "AiRulesVersionComputed"

export interface RenderAiRegistrySelectOptions {
	/**
	 * Expressions projected alongside the four computed columns — `OrgId`, `TraceId`, `Timestamp`
	 * for a rebuild; `SpanId` for a differential test. They must exist on the source relation.
	 */
	readonly passthrough?: ReadonlyArray<string>
}

/**
 * A complete, correctly layered SELECT over `from` (a table name, or a parenthesised subquery).
 *
 * Three nested projections, innermost first: vendor → session state → session key value. The
 * layering is not cosmetic — see the module header on alias inlining. `SELECT *` carries the source
 * columns inward so the outer expressions can still read `SpanAttributes`.
 */
export const renderAiRegistrySelect = (
	compiled: CompiledAiRegistrySql,
	from: string,
	options: RenderAiRegistrySelectOptions = {},
): string => {
	const projected = [
		...(options.passthrough ?? []),
		compiled.vendorAlias,
		compiled.sessionStateAlias,
		`${compiled.sessionKeyValueExpr} AS ${AI_REGISTRY_SESSION_KEY_VALUE_ALIAS}`,
		`${compiled.rulesVersionExpr} AS ${AI_REGISTRY_RULES_VERSION_ALIAS}`,
	]
	const withVendor = `SELECT\n\t*,\n\t${indent(compiled.vendorExpr)} AS ${compiled.vendorAlias}\nFROM ${from}`
	const withState = `SELECT\n\t*,\n\t${indent(compiled.sessionStateExpr)} AS ${compiled.sessionStateAlias}\nFROM (\n\t${indent(withVendor)}\n)`
	return `SELECT\n${projected.map((expression) => `\t${indent(expression)}`).join(",\n")}\nFROM (\n\t${indent(withState)}\n)`
}
