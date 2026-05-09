export interface FormulaDraft {
	id: string
	name: string
	expression: string
	legend: string
}

export interface TimeseriesPoint {
	bucket: string
	series: Record<string, number>
}

export interface QueryRunResult {
	queryId: string
	queryName: string
	source: string
	status: "success" | "error"
	error: string | null
	warnings: string[]
	data: TimeseriesPoint[]
}

type FormulaOperator = "+" | "-" | "*" | "/"
type FormulaUnaryOperator = "u-"

type FormulaToken =
	| { type: "number"; value: number }
	| { type: "identifier"; value: string }
	| { type: "operator"; value: FormulaOperator }
	| { type: "unary"; value: FormulaUnaryOperator }
	| { type: "leftParen" }
	| { type: "rightParen" }

const WARNING_BUCKET_SAMPLE_SIZE = 3

function tokenizeFormula(expression: string): {
	tokens: FormulaToken[]
	error: string | null
} {
	const tokens: FormulaToken[] = []
	const tokenRegex = /\s*([A-Za-z][A-Za-z0-9_]*|\d+(?:\.\d+)?|\.\d+|[()+\-*/])/y
	let index = 0

	while (index < expression.length) {
		tokenRegex.lastIndex = index
		const match = tokenRegex.exec(expression)

		if (!match) {
			const remaining = expression.slice(index).trim()
			if (!remaining) {
				break
			}

			return {
				tokens: [],
				error: `Invalid token near: ${remaining.slice(0, 16)}`,
			}
		}

		index = tokenRegex.lastIndex
		const rawToken = match[1]

		if (rawToken === "(") {
			tokens.push({ type: "leftParen" })
			continue
		}

		if (rawToken === ")") {
			tokens.push({ type: "rightParen" })
			continue
		}

		if (rawToken === "+" || rawToken === "-" || rawToken === "*" || rawToken === "/") {
			tokens.push({ type: "operator", value: rawToken })
			continue
		}

		if (/^\d/.test(rawToken) || rawToken.startsWith(".")) {
			tokens.push({ type: "number", value: Number.parseFloat(rawToken) })
			continue
		}

		tokens.push({ type: "identifier", value: rawToken.toUpperCase() })
	}

	return { tokens, error: null }
}

function compileFormula(expression: string): {
	rpn: FormulaToken[]
	identifiers: string[]
	error: string | null
} {
	const trimmed = expression.trim()
	if (!trimmed) {
		return {
			rpn: [],
			identifiers: [],
			error: "Formula expression is empty",
		}
	}

	const tokenized = tokenizeFormula(trimmed)
	if (tokenized.error) {
		return { rpn: [], identifiers: [], error: tokenized.error }
	}

	const output: FormulaToken[] = []
	const operatorStack: FormulaToken[] = []
	const identifiers = new Set<string>()
	const precedence: Record<FormulaOperator, number> = {
		"+": 1,
		"-": 1,
		"*": 2,
		"/": 2,
	}

	let previousToken: FormulaToken | null = null

	for (const token of tokenized.tokens) {
		if (token.type === "number") {
			output.push(token)
			previousToken = token
			continue
		}

		if (token.type === "identifier") {
			identifiers.add(token.value)
			output.push(token)
			previousToken = token
			continue
		}

		if (token.type === "leftParen") {
			operatorStack.push(token)
			previousToken = token
			continue
		}

		if (token.type === "rightParen") {
			let foundLeftParen = false

			while (operatorStack.length > 0) {
				const top = operatorStack.pop()!
				if (top.type === "leftParen") {
					foundLeftParen = true
					break
				}
				output.push(top)
			}
			// After the operand inside the parens has been emitted, any unary
			// operator that was waiting on it should be applied next.
			while (operatorStack.length > 0 && operatorStack[operatorStack.length - 1].type === "unary") {
				output.push(operatorStack.pop()!)
			}

			if (!foundLeftParen) {
				return {
					rpn: [],
					identifiers: [],
					error: "Mismatched parentheses in formula",
				}
			}

			previousToken = token
			continue
		}

		if (token.type === "operator") {
			const isUnaryContext =
				token.value === "-" &&
				(!previousToken || previousToken.type === "operator" || previousToken.type === "leftParen")

			if (isUnaryContext) {
				// Unary minus: high-precedence single-operand operator. Push it
				// directly onto the operator stack without popping any pending
				// binary operator — its operand hasn't been read yet.
				operatorStack.push({ type: "unary", value: "u-" })
				previousToken = token
				continue
			}

			while (operatorStack.length > 0) {
				const top = operatorStack[operatorStack.length - 1]
				if (top.type === "unary") {
					output.push(operatorStack.pop()!)
					continue
				}
				if (top.type !== "operator") {
					break
				}

				if (precedence[top.value] < precedence[token.value]) {
					break
				}

				output.push(operatorStack.pop()!)
			}

			operatorStack.push(token)
			previousToken = token
		}
	}

	while (operatorStack.length > 0) {
		const top = operatorStack.pop()!
		if (top.type === "leftParen" || top.type === "rightParen") {
			return {
				rpn: [],
				identifiers: [],
				error: "Mismatched parentheses in formula",
			}
		}
		output.push(top)
	}

	return {
		rpn: output,
		identifiers: [...identifiers],
		error: null,
	}
}

function evaluateCompiledFormula(
	rpn: FormulaToken[],
	variableValues: Record<string, number>,
): {
	value: number | null
	error: string | null
	reason: "division_by_zero" | "other" | null
} {
	const stack: number[] = []

	for (const token of rpn) {
		if (token.type === "number") {
			stack.push(token.value)
			continue
		}

		if (token.type === "identifier") {
			const value = variableValues[token.value]
			if (value == null) {
				return {
					value: null,
					error: `Unknown reference: ${token.value}`,
					reason: "other",
				}
			}

			stack.push(value)
			continue
		}

		if (token.type === "unary") {
			if (stack.length < 1) {
				return { value: null, error: "Invalid formula expression", reason: "other" }
			}
			const operand = stack.pop()!
			if (token.value === "u-") {
				stack.push(-operand)
				continue
			}
			return { value: null, error: "Invalid formula token", reason: "other" }
		}

		if (token.type !== "operator") {
			return { value: null, error: "Invalid formula token", reason: "other" }
		}

		if (stack.length < 2) {
			return { value: null, error: "Invalid formula expression", reason: "other" }
		}

		const right = stack.pop()!
		const left = stack.pop()!

		if (token.value === "+") {
			stack.push(left + right)
			continue
		}

		if (token.value === "-") {
			stack.push(left - right)
			continue
		}

		if (token.value === "*") {
			stack.push(left * right)
			continue
		}

		if (right === 0) {
			return {
				value: null,
				error: "Division by zero in formula",
				reason: "division_by_zero",
			}
		}

		stack.push(left / right)
	}

	if (stack.length !== 1) {
		return { value: null, error: "Invalid formula expression", reason: "other" }
	}

	const value = stack[0]
	if (!Number.isFinite(value)) {
		return { value: null, error: "Formula result is not finite", reason: "other" }
	}

	return { value, error: null, reason: null }
}

function aggregateByBucket(points: TimeseriesPoint[]): Map<string, number> {
	const aggregated = new Map<string, number>()

	for (const point of points) {
		if (Object.keys(point.series).length === 0) {
			continue
		}

		const total = Object.values(point.series).reduce(
			(sum, value) => sum + (Number.isFinite(value) ? value : 0),
			0,
		)
		aggregated.set(point.bucket, total)
	}

	return aggregated
}

function listUnionBuckets(bucketMaps: Map<string, number>[]): string[] {
	const bucketSet = new Set<string>()

	for (const bucketMap of bucketMaps) {
		for (const bucket of bucketMap.keys()) {
			bucketSet.add(bucket)
		}
	}

	return Array.from(bucketSet).toSorted()
}

function listIntersectedBuckets(bucketMaps: Map<string, number>[]): string[] {
	if (bucketMaps.length === 0) {
		return []
	}

	const [first, ...rest] = bucketMaps
	return [...first.keys()].filter((bucket) => rest.every((bucketMap) => bucketMap.has(bucket))).sort()
}

function formatBucketWarning(reason: string, buckets: string[]): string {
	if (buckets.length === 0) {
		return ""
	}

	const sample = buckets.slice(0, WARNING_BUCKET_SAMPLE_SIZE)
	const suffix =
		buckets.length > WARNING_BUCKET_SAMPLE_SIZE
			? ` (examples: ${sample.join(", ")}, +${buckets.length - sample.length} more)`
			: ` (bucket${sample.length === 1 ? "" : "s"}: ${sample.join(", ")})`

	return `Skipped ${buckets.length} ${buckets.length === 1 ? "bucket" : "buckets"} due to ${reason}${suffix}`
}

export function buildFormulaResults(
	formulas: FormulaDraft[],
	queryResults: QueryRunResult[],
): QueryRunResult[] {
	if (formulas.length === 0) {
		return []
	}

	const formulaResults: QueryRunResult[] = []
	const seriesByAlias = new Map<string, Map<string, number>>()

	for (const result of queryResults) {
		if (result.status !== "success") {
			continue
		}

		seriesByAlias.set(result.queryName.toUpperCase(), aggregateByBucket(result.data))
	}

	const allBuckets = listUnionBuckets([...seriesByAlias.values()])

	for (const formula of formulas) {
		const alias = formula.name.toUpperCase()
		const compiled = compileFormula(formula.expression)

		if (compiled.error) {
			formulaResults.push({
				queryId: formula.id,
				queryName: formula.name,
				source: "formula",
				status: "error",
				error: compiled.error,
				warnings: [],
				data: [],
			})
			continue
		}

		const missingIdentifiers = compiled.identifiers.filter((identifier) => !seriesByAlias.has(identifier))
		if (missingIdentifiers.length > 0) {
			formulaResults.push({
				queryId: formula.id,
				queryName: formula.name,
				source: "formula",
				status: "error",
				error: `Unknown references: ${missingIdentifiers.join(", ")}`,
				warnings: [],
				data: [],
			})
			continue
		}

		if (allBuckets.length === 0) {
			formulaResults.push({
				queryId: formula.id,
				queryName: formula.name,
				source: "formula",
				status: "error",
				error: "No successful query data available for formula execution",
				warnings: [],
				data: [],
			})
			continue
		}

		const referencedBucketMaps = compiled.identifiers
			.map((identifier) => seriesByAlias.get(identifier))
			.filter((bucketMap): bucketMap is Map<string, number> => bucketMap != null)

		const eligibleBuckets =
			referencedBucketMaps.length === 0 ? allBuckets : listIntersectedBuckets(referencedBucketMaps)

		const eligibleBucketSet = new Set(eligibleBuckets)
		const missingOperandBuckets =
			referencedBucketMaps.length === 0
				? []
				: listUnionBuckets(referencedBucketMaps).filter((bucket) => !eligibleBucketSet.has(bucket))

		const warnings: string[] = []
		if (missingOperandBuckets.length > 0) {
			const warning = formatBucketWarning("missing values for formula operands", missingOperandBuckets)
			if (warning) {
				warnings.push(warning)
			}
		}

		const seriesName = formula.legend.trim() || formula.name
		const data: TimeseriesPoint[] = []
		const divisionByZeroBuckets: string[] = []
		let evaluationError: string | null = null

		for (const bucket of eligibleBuckets) {
			const variableValues: Record<string, number> = {}

			for (const identifier of compiled.identifiers) {
				const value = seriesByAlias.get(identifier)?.get(bucket)
				if (value == null) {
					evaluationError = `Unknown reference: ${identifier} at bucket ${bucket}`
					break
				}

				variableValues[identifier] = value
			}

			if (evaluationError) {
				break
			}

			const evaluated = evaluateCompiledFormula(compiled.rpn, variableValues)
			if (evaluated.error) {
				if (evaluated.reason === "division_by_zero") {
					divisionByZeroBuckets.push(bucket)
					continue
				}

				evaluationError = `${evaluated.error} at bucket ${bucket}`
				break
			}

			data.push({
				bucket,
				series: {
					[seriesName]: evaluated.value ?? 0,
				},
			})
		}

		if (divisionByZeroBuckets.length > 0) {
			const warning = formatBucketWarning("division by zero in formula", divisionByZeroBuckets)
			if (warning) {
				warnings.push(warning)
			}
		}

		if (evaluationError) {
			formulaResults.push({
				queryId: formula.id,
				queryName: formula.name,
				source: "formula",
				status: "error",
				error: evaluationError,
				warnings,
				data: [],
			})
			continue
		}

		if (data.length === 0) {
			const error =
				divisionByZeroBuckets.length > 0
					? "Formula produced no valid buckets due to division by zero"
					: "Formula produced no valid buckets"

			formulaResults.push({
				queryId: formula.id,
				queryName: formula.name,
				source: "formula",
				status: "error",
				error,
				warnings,
				data: [],
			})
			continue
		}

		formulaResults.push({
			queryId: formula.id,
			queryName: formula.name,
			source: "formula",
			status: "success",
			error: null,
			warnings,
			data,
		})

		seriesByAlias.set(alias, aggregateByBucket(data))
	}

	return formulaResults
}
