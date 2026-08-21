import { createHash } from "node:crypto"
import { normalizedSchemaSql } from "./store-version"

export type LocalSchemaObjectKind = "table" | "materialized_view" | "view"

export interface LocalSchemaColumn {
	readonly name: string
	readonly type: string
	readonly defaultKind?: string
	readonly defaultExpression?: string
	readonly codec?: string
}

export interface LocalSchemaObject {
	readonly name: string
	readonly kind: LocalSchemaObjectKind
	readonly columns: ReadonlyArray<LocalSchemaColumn>
	readonly engine?: string
	readonly partitionBy?: string
	readonly orderBy?: string
	readonly ttl?: string
	readonly indexes: ReadonlyArray<string>
	/** Normalized bundled DDL for diagnostics and MV definition checks. */
	readonly definition: string
}

export interface LocalSchemaManifest {
	readonly objects: ReadonlyArray<LocalSchemaObject>
	readonly digest: string
}

export interface PhysicalSchemaObject {
	readonly name: string
	readonly kind: LocalSchemaObjectKind
	readonly columns: ReadonlyArray<LocalSchemaColumn>
	readonly engine?: string
	readonly partitionBy?: string
	readonly orderBy?: string
	readonly ttl?: string
	readonly indexes?: ReadonlyArray<string>
	readonly definition?: string
}

export interface PhysicalSchema {
	readonly objects: ReadonlyArray<PhysicalSchemaObject>
}

export interface PhysicalSchemaMismatch {
	readonly object: string
	readonly reason: string
}

const normalize = (value: string): string => value.replace(/\s+/g, " ").trim()

const stripTrailingComma = (value: string): string => value.trim().replace(/,\s*$/, "")

const matchingParen = (value: string, open: number): number => {
	let depth = 0
	let quote: "'" | '"' | "`" | null = null
	for (let i = open; i < value.length; i += 1) {
		const char = value[i]
		if (quote !== null) {
			if (char === quote && value[i - 1] !== "\\") quote = null
			continue
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char
			continue
		}
		if (char === "(") depth += 1
		if (char === ")") {
			depth -= 1
			if (depth === 0) return i
		}
	}
	return -1
}

const topLevelKeyword = (declaration: string, keywords: ReadonlyArray<string>): number => {
	let depth = 0
	let quote: "'" | '"' | "`" | null = null
	for (let i = 0; i < declaration.length; i += 1) {
		const char = declaration[i]
		if (quote !== null) {
			if (char === quote && declaration[i - 1] !== "\\") quote = null
			continue
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char
			continue
		}
		if (char === "(") depth += 1
		if (char === ")") depth -= 1
		if (depth !== 0 || !/\s/.test(char)) continue
		const rest = declaration.slice(i).trimStart()
		const hit = keywords.find((keyword) => new RegExp(`^${keyword}\\b`, "i").test(rest))
		if (hit !== undefined) return i + (declaration.slice(i).length - rest.length)
	}
	return -1
}

const parseColumn = (line: string): LocalSchemaColumn | undefined => {
	const trimmed = line.trim()
	if (/^INDEX\b/i.test(trimmed)) return undefined
	const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/)
	if (!match) return undefined
	const name = match[1]!
	const declaration = stripTrailingComma(match[2]!)
	const stop = topLevelKeyword(declaration, ["DEFAULT", "MATERIALIZED", "ALIAS", "CODEC", "COMMENT"])
	const type = normalize(stop === -1 ? declaration : declaration.slice(0, stop))
	if (type.length === 0) return undefined
	const attributes = stop === -1 ? "" : declaration.slice(stop).trim()
	const codecOffset = topLevelKeyword(attributes, ["CODEC"])
	const commentOffset = topLevelKeyword(attributes, ["COMMENT"])
	const defaultEnd = [codecOffset, commentOffset, attributes.length]
		.filter((offset) => offset >= 0)
		.sort((a, b) => a - b)[0]!
	const defaultClause = attributes.slice(0, defaultEnd).trim()
	const defaultMatch = defaultClause.match(/^(DEFAULT|MATERIALIZED|ALIAS)\s+(.+)$/i)
	const codecClause =
		codecOffset === -1
			? undefined
			: attributes.slice(codecOffset, commentOffset === -1 ? undefined : commentOffset).trim()
	return {
		name,
		type,
		...(!(defaultMatch === null)
			? {
					defaultKind: defaultMatch[1]!.toUpperCase(),
					defaultExpression: normalize(defaultMatch[2]!),
				}
			: undefined),
		...(!(codecClause === undefined) ? { codec: normalize(codecClause) } : undefined),
	}
}

const splitStatements = (sql: string): ReadonlyArray<string> => {
	// The generated snapshot separates statements by blank lines. Keep a small
	// quote-aware fallback for future generators that put a blank line inside a
	// view body.
	const statements: string[] = []
	const beginsCreate = (value: string): boolean =>
		/^(?:\s*--[^\n]*\n)*\s*CREATE\s+(?:TABLE|MATERIALIZED\s+VIEW|VIEW)\b/i.test(value)
	let current = ""
	let quote: "'" | '"' | "`" | null = null
	for (const line of sql.split("\n")) {
		current += `${line}\n`
		for (let i = 0; i < line.length; i += 1) {
			const char = line[i]
			if (quote !== null) {
				if (char === quote && line[i - 1] !== "\\") quote = null
				continue
			}
			// The rest of a `--` line is prose, and prose has apostrophes. Reading
			// one as an opening quote leaves the splitter "inside a string" for the
			// rest of the file, which silently fuses every remaining statement into
			// one — the manifest then just loses the objects instead of failing.
			if (char === "-" && line[i + 1] === "-") break
			if (char === "'" || char === '"' || char === "`") quote = char
		}
		if (quote === null && /^\s*$/.test(line) && current.trim().length > 0) {
			const candidate = current.trim()
			if (beginsCreate(candidate)) {
				statements.push(candidate.replace(/;\s*$/, ""))
				current = ""
			}
		}
	}
	if (current.trim().length > 0) {
		const candidate = current.trim()
		if (beginsCreate(candidate)) {
			statements.push(candidate.replace(/;\s*$/, ""))
		}
	}
	return statements
}

const parseStatement = (raw: string): LocalSchemaObject | undefined => {
	const statement = raw.replace(/--[^\n]*/g, "").trim()
	const table = statement.match(/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/i)
	const materialized = statement.match(
		/^CREATE\s+MATERIALIZED\s+VIEW\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/i,
	)
	const view = statement.match(/^CREATE\s+VIEW\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/i)
	const match = table ?? materialized ?? view
	if (!match) return undefined
	const kind: LocalSchemaObjectKind = table ? "table" : materialized ? "materialized_view" : "view"
	const name = match[1]!
	const open = statement.indexOf("(", match[0].length)
	const close = open === -1 ? -1 : matchingParen(statement, open)
	const columns =
		table && open !== -1 && close !== -1
			? statement
					.slice(open + 1, close)
					.split("\n")
					.map(parseColumn)
					.filter((column): column is LocalSchemaColumn => column !== undefined)
			: []
	const clause = close === -1 ? statement : statement.slice(close + 1)
	const engine = clause.match(/\bENGINE\s*=\s*([A-Za-z_][A-Za-z0-9_]*)/i)?.[1]
	const partitionBy = clause.match(
		/\bPARTITION\s+BY\s+(.+?)(?=\bORDER\s+BY\b|\bPRIMARY\s+KEY\b|\bTTL\b|\bSETTINGS\b|$)/is,
	)?.[1]
	const orderBy = clause.match(/\bORDER\s+BY\s+(.+?)(?=\bPRIMARY\s+KEY\b|\bTTL\b|\bSETTINGS\b|$)/is)?.[1]
	const ttl = clause.match(/\bTTL\s+(.+?)(?=\bSETTINGS\b|$)/is)?.[1]
	const indexes = [...statement.matchAll(/^\s*INDEX\s+([A-Za-z_][A-Za-z0-9_]*)\b/gim)].map(
		(match) => match[1]!,
	)
	return {
		name,
		kind,
		columns,
		...(!(engine === undefined) ? { engine: normalize(engine) } : undefined),
		...(!(partitionBy === undefined) ? { partitionBy: normalize(partitionBy) } : undefined),
		...(!(orderBy === undefined) ? { orderBy: normalize(orderBy) } : undefined),
		...(!(ttl === undefined) ? { ttl: normalize(ttl) } : undefined),
		indexes,
		definition: normalize(statement),
	}
}

export const buildLocalSchemaManifest = (schemaSql: string): LocalSchemaManifest => {
	const objects = splitStatements(schemaSql)
		.map(parseStatement)
		.filter((object): object is LocalSchemaObject => object !== undefined)
		.sort((a, b) => a.name.localeCompare(b.name))
	const stable = JSON.stringify(objects)
	return {
		objects,
		digest: createHash("sha256").update(stable).digest("hex"),
	}
}

/** Raise the bundled raw-telemetry TTLs to a configured retention floor.
 *
 * `--minimum-raw-telemetry-retention-days` alters those TTLs in place on the
 * opened store, so the physical definitions legitimately differ from the
 * bundled DDL. Verification compares against this derived manifest instead, and
 * still fails when the physical TTL is anything other than the floored value.
 * The digest is deliberately carried over unchanged: this manifest is a
 * comparison target, not a new schema identity. */
export const withRawTelemetryRetentionFloor = (
	manifest: LocalSchemaManifest,
	tables: ReadonlyArray<string>,
	days: number,
): LocalSchemaManifest => {
	const floored = new Set(tables)
	return {
		...manifest,
		objects: manifest.objects.map((object) => {
			if (!floored.has(object.name) || object.ttl === undefined) return object
			const raised = object.ttl.replace(/\bINTERVAL\s+(\d+)\s+DAY\b/i, (match, value: string) =>
				Number(value) >= days ? match : `INTERVAL ${days} DAY`,
			)
			return raised === object.ttl ? object : { ...object, ttl: raised }
		}),
	}
}

export const normalizedDefinition = (value: string): string => normalizedSchemaSql(value)

const normalizeType = (value: string): string => normalize(value).replace(/\s*,\s*/g, ", ")

const compareColumnAttribute = (actual: string | undefined, expected: string | undefined): boolean =>
	actual === undefined && expected === undefined
		? true
		: normalizeComparable(actual) === normalizeComparable(expected)

const normalizeComparable = (value: string | undefined): string | undefined =>
	value === undefined
		? undefined
		: (() => {
				const normalized = normalize(value)
					.replace(/\s*,\s*/g, ", ")
					.replace(/\btoIntervalDay\((\d+)\)/g, "INTERVAL $1 DAY")
					.replace(/\btoIntervalMonth\((\d+)\)/g, "INTERVAL $1 MONTH")
					.replace(/\btoIntervalHour\((\d+)\)/g, "INTERVAL $1 HOUR")
				if (normalized.length >= 2 && normalized.startsWith("(") && normalized.endsWith(")")) {
					return normalized.slice(1, -1).trim()
				}
				return normalized
			})()

/** Compare two column expressions. ClickHouse re-renders what it stores —
 * parenthesising sub-expressions and rewriting float literals (`1.0` -> `1.`) —
 * so a bundled DEFAULT and the reported one differ textually while meaning the
 * same thing. With a parser available both sides are rendered before
 * comparison; without one this degrades to whitespace normalization. */
const compareExpression = (
	actual: string | undefined,
	expected: string | undefined,
	normalizeSql?: (sql: string) => string | undefined,
): boolean => {
	if (compareColumnAttribute(actual, expected)) return true
	if (normalizeSql === undefined || actual === undefined || expected === undefined) return false
	const renderedActual = normalizeSql(`SELECT ${actual}`)
	const renderedExpected = normalizeSql(`SELECT ${expected}`)
	return renderedActual !== undefined && renderedActual === renderedExpected
}

/** Extract a view body — everything from the `AS` that introduces the query.
 * The bundled DDL and the definition ClickHouse reports back differ in database
 * qualification and in the injected column list, so only the query itself can
 * be compared across the two representations. */
export const viewBody = (definition: string): string | undefined => {
	const match = definition.match(/\bAS\s+(?=WITH\b|SELECT\b|\()/i)
	return match?.index === undefined ? undefined : definition.slice(match.index + match[0].length)
}

/** Compare a bundled structural manifest with an inspected chDB schema. This
 * is deliberately data-only so migration and startup can share the same
 * fail-closed gate and unit tests do not require native libchdb.
 *
 * `normalizeSql` renders a view body through a parser so the bundled
 * source text and ClickHouse's own rewritten text become comparable. Without
 * one, materialized-view bodies are only checked for parity after generic
 * whitespace normalization, which the two representations rarely satisfy. */
export const comparePhysicalSchema = (
	expected: LocalSchemaManifest,
	actual: PhysicalSchema,
	normalizeSql?: (sql: string) => string | undefined,
): ReadonlyArray<PhysicalSchemaMismatch> => {
	const actualByName = new Map(actual.objects.map((object) => [object.name, object]))
	const mismatches: PhysicalSchemaMismatch[] = []
	for (const desired of expected.objects) {
		const found = actualByName.get(desired.name)
		if (!found) {
			mismatches.push({ object: desired.name, reason: `missing ${desired.kind}` })
			continue
		}
		if (found.kind !== desired.kind) {
			mismatches.push({ object: desired.name, reason: `expected ${desired.kind}, found ${found.kind}` })
			continue
		}
		if (desired.kind === "table") {
			const foundColumns = new Map(found.columns.map((column) => [column.name, column.type]))
			for (const column of desired.columns) {
				const actualType = foundColumns.get(column.name)
				if (actualType === undefined) {
					mismatches.push({ object: desired.name, reason: `missing column ${column.name}` })
				} else if (normalizeType(actualType) !== normalizeType(column.type)) {
					mismatches.push({
						object: desired.name,
						reason: `column ${column.name} has type ${actualType}; expected ${column.type}`,
					})
				}
			}
			for (const column of desired.columns) {
				const actual = found.columns.find((candidate) => candidate.name === column.name)
				if (actual === undefined) continue
				if (!compareColumnAttribute(actual.defaultKind, column.defaultKind)) {
					mismatches.push({
						object: desired.name,
						reason: `column ${column.name} default kind differs`,
					})
				}
				if (!compareExpression(actual.defaultExpression, column.defaultExpression, normalizeSql)) {
					mismatches.push({
						object: desired.name,
						reason: `column ${column.name} default expression differs`,
					})
				}
				if (column.codec !== undefined && !compareColumnAttribute(actual.codec, column.codec)) {
					mismatches.push({ object: desired.name, reason: `column ${column.name} codec differs` })
				}
			}
			const desiredColumns = new Set(desired.columns.map((column) => column.name))
			for (const column of found.columns) {
				if (!desiredColumns.has(column.name)) {
					mismatches.push({ object: desired.name, reason: `unexpected column ${column.name}` })
				}
			}
		}
		if (
			desired.engine !== undefined &&
			normalizeComparable(found.engine) !== normalizeComparable(desired.engine)
		) {
			mismatches.push({
				object: desired.name,
				reason: `engine differs (${found.engine} vs ${desired.engine})`,
			})
		}
		for (const [label, wanted, got] of [
			["partition key", desired.partitionBy, found.partitionBy],
			["sorting key", desired.orderBy, found.orderBy],
			["TTL", desired.ttl, found.ttl],
		] as const) {
			if (wanted !== undefined && normalizeComparable(got) !== normalizeComparable(wanted)) {
				mismatches.push({ object: desired.name, reason: `${label} differs (${got} vs ${wanted})` })
			}
		}
		if (found.indexes !== undefined) {
			const actualIndexes = new Set(found.indexes)
			for (const index of desired.indexes) {
				if (!actualIndexes.has(index))
					mismatches.push({ object: desired.name, reason: `missing index ${index}` })
			}
			for (const index of actualIndexes) {
				if (!desired.indexes.includes(index))
					mismatches.push({ object: desired.name, reason: `unexpected index ${index}` })
			}
		}
		if (desired.kind === "materialized_view" && found.definition !== undefined) {
			const expectedBody = viewBody(desired.definition)
			const actualBody = viewBody(found.definition)
			if (expectedBody !== undefined && expectedBody.length > 0) {
				if (actualBody === undefined) {
					mismatches.push({
						object: desired.name,
						reason: "materialized-view has no readable body",
					})
				} else if (normalizeSql === undefined) {
					// No parser available: fall back to whitespace-normalized containment,
					// which only catches gross drift.
					if (!normalizedDefinition(actualBody).includes(normalizedDefinition(expectedBody)))
						mismatches.push({
							object: desired.name,
							reason: "materialized-view definition differs",
						})
				} else {
					const wanted = normalizeSql(expectedBody)
					const got = normalizeSql(actualBody)
					if (wanted === undefined || got === undefined) {
						mismatches.push({
							object: desired.name,
							reason: "materialized-view definition could not be parsed for comparison",
						})
					} else if (wanted !== got) {
						mismatches.push({
							object: desired.name,
							reason: "materialized-view definition differs",
						})
					}
				}
			}
		}
	}
	const expectedNames = new Set(expected.objects.map((object) => object.name))
	for (const object of actual.objects) {
		if (!expectedNames.has(object.name)) {
			mismatches.push({ object: object.name, reason: `unexpected ${object.kind}` })
		}
	}
	return mismatches
}
