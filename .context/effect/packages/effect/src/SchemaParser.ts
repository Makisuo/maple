/**
 * @since 4.0.0
 */
import * as Arr from "./Array.ts"
import * as Cause from "./Cause.ts"
import * as Effect from "./Effect.ts"
import * as Exit from "./Exit.ts"
import { identity, memoize } from "./Function.ts"
import * as InternalAnnotations from "./internal/schema/annotations.ts"
import * as Option from "./Option.ts"
import * as Predicate from "./Predicate.ts"
import * as Result from "./Result.ts"
import type * as Schema from "./Schema.ts"
import * as AST from "./SchemaAST.ts"
import * as Issue from "./SchemaIssue.ts"

const recurDefaults = memoize((ast: AST.AST): AST.AST => {
  switch (ast._tag) {
    case "Declaration": {
      const getLink = ast.annotations?.[AST.ClassTypeId]
      if (Predicate.isFunction(getLink)) {
        const link = getLink(ast.typeParameters)
        const to = recurDefaults(link.to)
        return AST.replaceEncoding(ast, to === link.to ? [link] : [new AST.Link(to, link.transformation)])
      }
      return ast
    }
    case "Objects":
    case "Arrays":
      return ast.recur((ast) => {
        const defaultValue = ast.context?.defaultValue
        if (defaultValue) {
          return AST.replaceEncoding(recurDefaults(ast), defaultValue)
        }
        return recurDefaults(ast)
      })
    case "Suspend":
      return ast.recur(recurDefaults)
    default:
      return ast
  }
})

/**
 * @category Constructing
 * @since 4.0.0
 */
export function makeEffect<S extends Schema.Top>(schema: S) {
  const ast = recurDefaults(AST.toType(schema.ast))
  const parser = run<S["Type"], never>(ast)
  return (input: S["~type.make.in"], options?: Schema.MakeOptions): Effect.Effect<S["Type"], Issue.Issue> => {
    return parser(
      input,
      options?.disableChecks
        ? options?.parseOptions ? { ...options.parseOptions, disableChecks: true } : { disableChecks: true }
        : options?.parseOptions
    )
  }
}

/**
 * @category Constructing
 * @since 4.0.0
 */
export function makeOption<S extends Schema.Top>(schema: S) {
  const parser = makeEffect(schema)
  return (input: S["~type.make.in"], options?: Schema.MakeOptions): Option.Option<S["Type"]> => {
    return Exit.getSuccess(Effect.runSyncExit(parser(input, options) as any))
  }
}

/**
 * @category Constructing
 * @since 4.0.0
 */
export function makeUnsafe<S extends Schema.Top>(schema: S) {
  const parser = makeEffect(schema)
  return (input: S["~type.make.in"], options?: Schema.MakeOptions): S["Type"] => {
    return Effect.runSync(
      Effect.mapErrorEager(
        parser(input, options),
        (issue) => new Error(issue.toString(), { cause: issue })
      )
    )
  }
}

/**
 * @category Asserting
 * @since 4.0.0
 */
export function is<T>(schema: Schema.Schema<T>): <I>(input: I) => input is I & T {
  return _is<T>(schema.ast)
}

/** @internal */
export function _is<T>(ast: AST.AST) {
  const parser = asExit(run<T, never>(AST.toType(ast)))
  return <I>(input: I): input is I & T => {
    return Exit.isSuccess(parser(input, AST.defaultParseOptions))
  }
}

/** @internal */
export function _issue<T>(ast: AST.AST) {
  const parser = run<T, never>(ast)
  return (input: unknown, options: AST.ParseOptions): Issue.Issue | undefined => {
    return Effect.runSync(Effect.matchEager(parser(input, options), {
      onSuccess: () => undefined,
      onFailure: identity
    }))
  }
}

/**
 * @category Asserting
 * @since 4.0.0
 */
export function asserts<T>(schema: Schema.Schema<T>) {
  const parser = asExit(run<T, never>(AST.toType(schema.ast)))
  return <I>(input: I): asserts input is I & T => {
    const exit = parser(input, AST.defaultParseOptions)
    if (Exit.isFailure(exit)) {
      const issue = Cause.findError(exit.cause)
      if (Result.isFailure(issue)) {
        throw Cause.squash(issue.failure)
      }
      throw new Error(issue.success.toString(), { cause: issue.success })
    }
  }
}

/**
 * @category Decoding
 * @since 4.0.0
 */
export function decodeUnknownEffect<S extends Schema.Top>(
  schema: S
): (input: unknown, options?: AST.ParseOptions) => Effect.Effect<S["Type"], Issue.Issue, S["DecodingServices"]> {
  return run<S["Type"], S["DecodingServices"]>(schema.ast)
}

/**
 * @category Decoding
 * @since 4.0.0
 */
export const decodeEffect: <S extends Schema.Top>(
  schema: S
) => (input: S["Encoded"], options?: AST.ParseOptions) => Effect.Effect<S["Type"], Issue.Issue, S["DecodingServices"]> =
  decodeUnknownEffect

/**
 * @category Decoding
 * @since 4.0.0
 */
export function decodeUnknownPromise<S extends Schema.Decoder<unknown>>(
  schema: S
): (input: unknown, options?: AST.ParseOptions) => Promise<S["Type"]> {
  return asPromise(decodeUnknownEffect(schema))
}

/**
 * @category Decoding
 * @since 4.0.0
 */
export function decodePromise<S extends Schema.Decoder<unknown>>(
  schema: S
): (input: S["Encoded"], options?: AST.ParseOptions) => Promise<S["Type"]> {
  return asPromise(decodeEffect(schema))
}

/**
 * @category Decoding
 * @since 4.0.0
 */
export function decodeUnknownExit<S extends Schema.Decoder<unknown>>(
  schema: S
): (input: unknown, options?: AST.ParseOptions) => Exit.Exit<S["Type"], Issue.Issue> {
  return asExit(decodeUnknownEffect(schema))
}

/**
 * @category Decoding
 * @since 4.0.0
 */
export const decodeExit: <S extends Schema.Decoder<unknown>>(
  schema: S
) => (input: S["Encoded"], options?: AST.ParseOptions) => Exit.Exit<S["Type"], Issue.Issue> = decodeUnknownExit

/**
 * @category Decoding
 * @since 4.0.0
 */
export function decodeUnknownOption<S extends Schema.Decoder<unknown>>(
  schema: S
): (input: unknown, options?: AST.ParseOptions) => Option.Option<S["Type"]> {
  return asOption(decodeUnknownEffect(schema))
}

/**
 * @category Decoding
 * @since 4.0.0
 */
export const decodeOption: <S extends Schema.Decoder<unknown>>(
  schema: S
) => (input: S["Encoded"], options?: AST.ParseOptions) => Option.Option<S["Type"]> = decodeUnknownOption

/**
 * @category Decoding
 * @since 4.0.0
 */
export function decodeUnknownResult<S extends Schema.Decoder<unknown>>(
  schema: S
): (input: unknown, options?: AST.ParseOptions) => Result.Result<S["Type"], Issue.Issue> {
  return asResult(decodeUnknownEffect(schema))
}

/**
 * @category Decoding
 * @since 4.0.0
 */
export const decodeResult: <S extends Schema.Decoder<unknown>>(
  schema: S
) => (input: S["Encoded"], options?: AST.ParseOptions) => Result.Result<S["Type"], Issue.Issue> = decodeUnknownResult

/**
 * @category Decoding
 * @since 4.0.0
 */
export function decodeUnknownSync<S extends Schema.Decoder<unknown>>(
  schema: S
): (input: unknown, options?: AST.ParseOptions) => S["Type"] {
  return asSync(decodeUnknownEffect(schema))
}

/**
 * @category Decoding
 * @since 4.0.0
 */
export const decodeSync: <S extends Schema.Decoder<unknown>>(
  schema: S
) => (input: S["Encoded"], options?: AST.ParseOptions) => S["Type"] = decodeUnknownSync

/**
 * @category Encoding
 * @since 4.0.0
 */
export function encodeUnknownEffect<S extends Schema.Top>(
  schema: S
): (input: unknown, options?: AST.ParseOptions) => Effect.Effect<S["Encoded"], Issue.Issue, S["EncodingServices"]> {
  return run<S["Encoded"], S["EncodingServices"]>(AST.flip(schema.ast))
}

/**
 * @category Encoding
 * @since 4.0.0
 */
export const encodeEffect: <S extends Schema.Top>(
  schema: S
) => (input: S["Type"], options?: AST.ParseOptions) => Effect.Effect<S["Encoded"], Issue.Issue, S["EncodingServices"]> =
  encodeUnknownEffect

/**
 * @category Encoding
 * @since 4.0.0
 */
export const encodeUnknownPromise = <S extends Schema.Encoder<unknown>>(
  schema: S
): (input: unknown, options?: AST.ParseOptions) => Promise<S["Encoded"]> => asPromise(encodeUnknownEffect(schema))

/**
 * @category Encoding
 * @since 4.0.0
 */
export const encodePromise: <S extends Schema.Encoder<unknown>>(
  schema: S
) => (input: S["Type"], options?: AST.ParseOptions) => Promise<S["Encoded"]> = encodeUnknownPromise

/**
 * @category Encoding
 * @since 4.0.0
 */
export function encodeUnknownExit<S extends Schema.Encoder<unknown>>(
  schema: S
): (input: unknown, options?: AST.ParseOptions) => Exit.Exit<S["Encoded"], Issue.Issue> {
  return asExit(encodeUnknownEffect(schema))
}

/**
 * @category Encoding
 * @since 4.0.0
 */
export const encodeExit: <S extends Schema.Encoder<unknown>>(
  schema: S
) => (input: S["Type"], options?: AST.ParseOptions) => Exit.Exit<S["Encoded"], Issue.Issue> = encodeUnknownExit

/**
 * @category Encoding
 * @since 4.0.0
 */
export function encodeUnknownOption<S extends Schema.Encoder<unknown>>(
  schema: S
): (input: unknown, options?: AST.ParseOptions) => Option.Option<S["Encoded"]> {
  return asOption(encodeUnknownEffect(schema))
}

/**
 * @category Encoding
 * @since 4.0.0
 */
export const encodeOption: <S extends Schema.Encoder<unknown>>(
  schema: S
) => (input: S["Type"], options?: AST.ParseOptions) => Option.Option<S["Encoded"]> = encodeUnknownOption

/**
 * @category Encoding
 * @since 4.0.0
 */
export function encodeUnknownResult<S extends Schema.Encoder<unknown>>(
  schema: S
): (input: unknown, options?: AST.ParseOptions) => Result.Result<S["Encoded"], Issue.Issue> {
  return asResult(encodeUnknownEffect(schema))
}

/**
 * @category Encoding
 * @since 4.0.0
 */
export const encodeResult: <S extends Schema.Encoder<unknown>>(
  schema: S
) => (input: S["Type"], options?: AST.ParseOptions) => Result.Result<S["Encoded"], Issue.Issue> = encodeUnknownResult

/**
 * @category Encoding
 * @since 4.0.0
 */
export function encodeUnknownSync<S extends Schema.Encoder<unknown>>(
  schema: S
): (input: unknown, options?: AST.ParseOptions) => S["Encoded"] {
  return asSync(encodeUnknownEffect(schema))
}

/**
 * @category Encoding
 * @since 4.0.0
 */
export const encodeSync: <S extends Schema.Encoder<unknown>>(
  schema: S
) => (input: S["Type"], options?: AST.ParseOptions) => S["Encoded"] = encodeUnknownSync

/** @internal */
export function run<T, R>(ast: AST.AST) {
  const parser = recur(ast)
  return (input: unknown, options?: AST.ParseOptions): Effect.Effect<T, Issue.Issue, R> =>
    Effect.flatMapEager(parser(Option.some(input), options ?? AST.defaultParseOptions), (oa) => {
      if (oa._tag === "None") {
        return Effect.fail(new Issue.InvalidValue(oa))
      }
      return Effect.succeed(oa.value as T)
    })
}

function asPromise<T, E>(
  parser: (input: E, options?: AST.ParseOptions) => Effect.Effect<T, Issue.Issue>
): (input: E, options?: AST.ParseOptions) => Promise<T> {
  return (input: E, options?: AST.ParseOptions) => Effect.runPromise(parser(input, options))
}

function asExit<T, E, R>(
  parser: (input: E, options?: AST.ParseOptions) => Effect.Effect<T, Issue.Issue, R>
): (input: E, options?: AST.ParseOptions) => Exit.Exit<T, Issue.Issue> {
  return (input: E, options?: AST.ParseOptions) => Effect.runSyncExit(parser(input, options) as any)
}

/** @internal */
export function asOption<T, E, R>(
  parser: (input: E, options?: AST.ParseOptions) => Effect.Effect<T, Issue.Issue, R>
): (input: E, options?: AST.ParseOptions) => Option.Option<T> {
  const parserExit = asExit(parser)
  return (input: E, options?: AST.ParseOptions) => Exit.getSuccess(parserExit(input, options))
}

function asResult<T, E, R>(
  parser: (input: E, options?: AST.ParseOptions) => Effect.Effect<T, Issue.Issue, R>
): (input: E, options?: AST.ParseOptions) => Result.Result<T, Issue.Issue> {
  const parserExit = asExit(parser)
  return (input: E, options?: AST.ParseOptions) => {
    const exit = parserExit(input, options)
    if (Exit.isSuccess(exit)) {
      return Result.succeed(exit.value)
    }
    const error = Cause.findError(exit.cause)
    if (Result.isFailure(error)) {
      throw Cause.squash(error.failure)
    }
    return Result.fail(error.success)
  }
}

function asSync<T, E, R>(
  parser: (input: E, options?: AST.ParseOptions) => Effect.Effect<T, Issue.Issue, R>
): (input: E, options?: AST.ParseOptions) => T {
  return (input: E, options?: AST.ParseOptions) =>
    Effect.runSync(
      Effect.mapErrorEager(
        parser(input, options),
        (issue) => new Error(issue.toString(), { cause: issue })
      ) as any
    )
}

/** @internal */
export interface Parser {
  (input: Option.Option<unknown>, options: AST.ParseOptions): Effect.Effect<Option.Option<unknown>, Issue.Issue, any>
}

const recur = memoize(
  (ast: AST.AST): Parser => {
    let parser: Parser
    const astOptions = InternalAnnotations.resolve(ast)?.["parseOptions"]
    if (!ast.context && !ast.encoding && !ast.checks) {
      return (ou, options) => {
        parser ??= ast.getParser(recur)
        if (astOptions) {
          options = { ...options, ...astOptions }
        }
        return parser(ou, options)
      }
    }
    const isStructural = AST.isArrays(ast) || AST.isObjects(ast) ||
      (AST.isDeclaration(ast) && ast.typeParameters.length > 0)
    return (ou, options) => {
      if (astOptions) {
        options = { ...options, ...astOptions }
      }
      const encoding = ast.encoding
      let srou: Effect.Effect<Option.Option<unknown>, Issue.Issue, unknown> | undefined
      if (encoding) {
        const links = encoding
        const len = links.length
        for (let i = len - 1; i >= 0; i--) {
          const link = links[i]
          const to = link.to
          const parser = recur(to)
          srou = srou ? Effect.flatMapEager(srou, (ou) => parser(ou, options)) : parser(ou, options)
          if (link.transformation._tag === "Transformation") {
            const getter = link.transformation.decode
            srou = Effect.flatMapEager(srou, (ou) => getter.run(ou, options))
          } else {
            srou = link.transformation.decode(srou, options)
          }
        }
        srou = Effect.mapErrorEager(srou!, (issue) => new Issue.Encoding(ast, ou, issue))
      }

      parser ??= ast.getParser(recur)
      let sroa = srou ? Effect.flatMapEager(srou, (ou) => parser(ou, options)) : parser(ou, options)

      if (ast.checks && !options?.disableChecks) {
        const checks = ast.checks
        if (options?.errors === "all" && isStructural && Option.isSome(ou)) {
          sroa = Effect.catchEager(sroa, (issue) => {
            const issues: Array<Issue.Issue> = []
            AST.collectIssues(
              checks.filter((check) => check.annotations?.[AST.STRUCTURAL_ANNOTATION_KEY]),
              ou.value,
              issues,
              ast,
              options
            )
            const out: Issue.Issue = Arr.isArrayNonEmpty(issues)
              ? issue._tag === "Composite" && issue.ast === ast
                ? new Issue.Composite(ast, issue.actual, [...issue.issues, ...issues])
                : new Issue.Composite(ast, ou, [issue, ...issues])
              : issue
            return Effect.fail(out)
          })
        }
        sroa = Effect.flatMapEager(sroa, (oa) => {
          if (Option.isSome(oa)) {
            const value = oa.value
            const issues: Array<Issue.Issue> = []

            AST.collectIssues(checks, value, issues, ast, options)

            if (Arr.isArrayNonEmpty(issues)) {
              return Effect.fail(new Issue.Composite(ast, oa, issues))
            }
          }
          return Effect.succeed(oa)
        })
      }

      return sroa
    }
  }
)
