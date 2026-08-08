import type { FieldNamespace, FieldRef, NormalizedSignal, SignalPredicate, SignalScalarType } from "./model"
import { fieldKey } from "./model"
import type { ValidationIssue } from "./predicate"

export type SignalLeafOperator = "exists" | "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "in"
export type ReplayCapability = "exact" | "coerced" | "unavailable"

export interface SignalFieldCatalogEntry {
	readonly field: FieldRef
	readonly operators: readonly SignalLeafOperator[]
	readonly sensitivity: "public" | "sensitive"
	readonly replay: ReplayCapability
}

export interface OpenFieldNamespacePolicy {
	readonly namespace: FieldNamespace
	readonly types: readonly SignalScalarType[]
	readonly operators: readonly SignalLeafOperator[]
	readonly sensitivity: "public" | "sensitive"
	readonly replay: ReplayCapability
}

export interface SignalSourceDefinition {
	readonly sourceKind: string
	readonly fields: readonly SignalFieldCatalogEntry[]
	readonly openFields?: readonly OpenFieldNamespacePolicy[]
}

export interface SignalSourceAdapter<TRaw, TContext = unknown> {
	readonly definition: SignalSourceDefinition
	readonly normalize: (raw: TRaw, context: TContext) => readonly NormalizedSignal[]
}

interface RegisteredSignalSource {
	readonly definition: SignalSourceDefinition
	readonly fields: ReadonlyMap<string, SignalFieldCatalogEntry>
	readonly openFields: ReadonlyMap<FieldNamespace, OpenFieldNamespacePolicy>
}

export class SignalSourceRegistry {
	readonly #sources = new Map<string, RegisteredSignalSource>()

	register(definition: SignalSourceDefinition): this {
		if (definition.sourceKind.trim().length === 0) throw new Error("source kind must not be empty")
		if (this.#sources.has(definition.sourceKind))
			throw new Error(`duplicate source registration: ${definition.sourceKind}`)

		const fields = new Map<string, SignalFieldCatalogEntry>()
		for (const entry of definition.fields) {
			const key = fieldKey(entry.field)
			if (fields.has(key))
				throw new Error(`duplicate field catalog entry: ${definition.sourceKind}:${key}`)
			if (entry.operators.length === 0) throw new Error(`field catalog entry has no operators: ${key}`)
			fields.set(key, entry)
		}

		const openFields = new Map<FieldNamespace, OpenFieldNamespacePolicy>()
		for (const policy of definition.openFields ?? []) {
			if (openFields.has(policy.namespace))
				throw new Error(`duplicate open field policy: ${definition.sourceKind}:${policy.namespace}`)
			if (policy.types.length === 0 || policy.operators.length === 0)
				throw new Error(`open field policy must declare types and operators: ${policy.namespace}`)
			openFields.set(policy.namespace, policy)
		}

		this.#sources.set(definition.sourceKind, { definition, fields, openFields })
		return this
	}

	get(sourceKind: string): RegisteredSignalSource | undefined {
		return this.#sources.get(sourceKind)
	}
}

const leafFields = (
	predicate: SignalPredicate,
): ReadonlyArray<{
	readonly field: FieldRef
	readonly operator: SignalLeafOperator
	readonly path: string
}> => {
	const fields: Array<{ field: FieldRef; operator: SignalLeafOperator; path: string }> = []
	const visit = (node: SignalPredicate, path: string): void => {
		switch (node.op) {
			case "all":
			case "any":
				for (let i = 0; i < node.clauses.length; i++) visit(node.clauses[i]!, `${path}.clauses[${i}]`)
				break
			case "not":
				visit(node.clause, `${path}.clause`)
				break
			default:
				fields.push({ field: node.field, operator: node.op, path })
		}
	}
	visit(predicate, "selector")
	return fields
}

export const validatePredicateAgainstSource = (
	predicate: SignalPredicate,
	source: RegisteredSignalSource,
): readonly ValidationIssue[] => {
	const issues: ValidationIssue[] = []
	for (const leaf of leafFields(predicate)) {
		const catalogEntry = source.fields.get(fieldKey(leaf.field))
		if (catalogEntry) {
			if (catalogEntry.field.type !== leaf.field.type)
				issues.push({
					path: `${leaf.path}.field.type`,
					message: `catalog field ${fieldKey(leaf.field)} has type ${catalogEntry.field.type}`,
				})
			if (!catalogEntry.operators.includes(leaf.operator))
				issues.push({
					path: `${leaf.path}.op`,
					message: `${leaf.operator} is not allowed for catalog field ${fieldKey(leaf.field)}`,
				})
			continue
		}

		const open = source.openFields.get(leaf.field.namespace)
		if (!open) {
			issues.push({
				path: `${leaf.path}.field`,
				message: `unknown field ${fieldKey(leaf.field)} for source ${source.definition.sourceKind}`,
			})
			continue
		}
		if (!open.types.includes(leaf.field.type))
			issues.push({
				path: `${leaf.path}.field.type`,
				message: `${leaf.field.type} is not allowed for open ${leaf.field.namespace} fields`,
			})
		if (!open.operators.includes(leaf.operator))
			issues.push({
				path: `${leaf.path}.op`,
				message: `${leaf.operator} is not allowed for open ${leaf.field.namespace} fields`,
			})
	}
	return issues
}
