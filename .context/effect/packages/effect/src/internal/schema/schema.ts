import * as Cause from "../../Cause.ts"
import * as Data from "../../Data.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as Pipeable from "../../Pipeable.ts"
import type * as Schema from "../../Schema.ts"
import * as SchemaAST from "../../SchemaAST.ts"
import type { Issue } from "../../SchemaIssue.ts"
import * as SchemaParser from "../../SchemaParser.ts"

/** @internal */
export const TypeId = "~effect/Schema/Schema"

const SchemaProto = {
  [TypeId]: TypeId,
  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  },
  annotate(this: Schema.Top, annotations: Schema.Annotations.Annotations) {
    return this.rebuild(SchemaAST.annotate(this.ast, annotations))
  },
  annotateKey(this: Schema.Top, annotations: Schema.Annotations.Key<unknown>) {
    return this.rebuild(SchemaAST.annotateKey(this.ast, annotations))
  },
  check(this: Schema.Top, ...checks: readonly [SchemaAST.Check<unknown>, ...Array<SchemaAST.Check<unknown>>]) {
    return this.rebuild(SchemaAST.appendChecks(this.ast, checks))
  }
}

/** @internal */
export function make<S extends Schema.Constraint>(ast: S["ast"], options?: object): S {
  const self = Object.create(SchemaProto)
  if (options) {
    Object.assign(self, options)
  }
  self.ast = ast
  self.rebuild = (ast: SchemaAST.AST) => make(ast, options)
  self.makeEffect = (input: S["~type.make.in"], options?: Schema.MakeOptions) =>
    mapSchemaIssueEffect(SchemaParser.makeEffect(self)(input, options))
  self.make = SchemaParser.make(self)
  self.makeOption = SchemaParser.makeOption(self)
  return self
}

/** @internal */
export const SchemaErrorTypeId = "~effect/Schema/SchemaError"

// purposefully not internal
export class SchemaError extends Data.TaggedError("SchemaError")<{
  readonly issue: Issue
}> {
  readonly [SchemaErrorTypeId]: typeof SchemaErrorTypeId = SchemaErrorTypeId
  constructor(issue: Issue) {
    super({ issue })
  }
  override get message() {
    return this.issue.toString()
  }
  override toString() {
    return `SchemaError(${this.message})`
  }
}

/** @internal */
export function mapSchemaIssueEffect<A, R>(
  self: Effect.Effect<A, Issue, R>
): Effect.Effect<A, SchemaError, R> {
  return Effect.catchCause(
    self,
    (cause) => Effect.failCauseSync(() => Cause.map(cause, (issue) => new SchemaError(issue)))
  )
}

/** @internal */
export function mapSchemaErrorEffect<A, R>(
  self: Effect.Effect<A, SchemaError, R>
): Effect.Effect<A, Issue, R> {
  return Effect.catchCause(self, (cause) => Effect.failCauseSync(() => Cause.map(cause, (error) => error.issue)))
}

/** @internal */
export function mapSchemaIssueExit<A>(exit: Exit.Exit<A, Issue>): Exit.Exit<A, SchemaError> {
  return Exit.isSuccess(exit)
    ? Exit.succeed(exit.value)
    : Exit.failCause(Cause.map(exit.cause, (issue) => new SchemaError(issue)))
}

/** @internal */
export const jsonReorder = makeReorder(getJsonPriority)

function getJsonPriority(ast: SchemaAST.AST): number {
  switch (ast._tag) {
    case "BigInt":
    case "Symbol":
    case "UniqueSymbol":
      return 0
    default:
      return 1
  }
}

/** @internal */
export function makeReorder(getPriority: (ast: SchemaAST.AST) => number) {
  return (types: ReadonlyArray<SchemaAST.AST>): ReadonlyArray<SchemaAST.AST> => {
    // Create a map of original indices for O(1) lookup
    const indexMap = new Map<SchemaAST.AST, number>()
    for (let i = 0; i < types.length; i++) {
      indexMap.set(SchemaAST.toEncoded(types[i]), i)
    }

    // Create a sorted copy of the types array
    const sortedTypes = [...types].sort((a, b) => {
      a = SchemaAST.toEncoded(a)
      b = SchemaAST.toEncoded(b)
      const pa = getPriority(a)
      const pb = getPriority(b)
      if (pa !== pb) return pa - pb
      // If priorities are equal, maintain original order (stable sort)
      return indexMap.get(a)! - indexMap.get(b)!
    })

    // Check if order changed by comparing arrays
    const orderChanged = sortedTypes.some((ast, index) => ast !== types[index])

    if (!orderChanged) return types
    return sortedTypes
  }
}
