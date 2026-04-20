/**
 * This module provides types and utility functions to create and work with
 * branded types, which are TypeScript types with an added type tag to prevent
 * accidental usage of a value in the wrong context.
 *
 * @since 2.0.0
 */
import * as Arr from "./Array.ts"
import * as Option from "./Option.ts"
import * as Result from "./Result.ts"
import type * as Schema from "./Schema.ts"
import * as AST from "./SchemaAST.ts"
import type * as Issue from "./SchemaIssue.ts"
import type * as Types from "./Types.ts"

const TypeId = "~effect/Brand"

/**
 * A generic interface that defines a branded type.
 *
 * @since 2.0.0
 * @category models
 */
export interface Brand<in out Keys extends string> {
  readonly [TypeId]: {
    readonly [K in Keys]: Keys
  }
}

/**
 * A constructor for a branded type that provides validation and safe
 * construction methods.
 *
 * @category models
 * @since 2.0.0
 */
export interface Constructor<in out B extends Brand<any>> {
  /**
   * Constructs a branded type from a value of type `Unbranded<B>`, throwing an
   * error if the provided value is not valid.
   */
  (unbranded: Brand.Unbranded<B>): B
  /**
   * Constructs a branded type from a value of type `Unbranded<B>`, returning
   * `Some<B>` if the provided value is valid, `None` otherwise.
   */
  option(unbranded: Brand.Unbranded<B>): Option.Option<B>
  /**
   * Constructs a branded type from a value of type `Unbranded<B>`, returning
   * `Success<B>` if the provided value is valid, `Failure<BrandError>`
   * otherwise.
   */
  result(unbranded: Brand.Unbranded<B>): Result.Result<B, BrandError>
  /**
   * Attempts to refine the provided value of type `Unbranded<B>`, returning
   * `true` if the provided value is a valid branded type, `false` otherwise.
   */
  is(unbranded: Brand.Unbranded<B>): unbranded is Brand.Unbranded<B> & B

  /**
   * The checks that are applied to the branded type.
   *
   * @internal
   */
  checks?: readonly [AST.Check<Brand.Unbranded<B>>, ...Array<AST.Check<Brand.Unbranded<B>>>] | undefined
}

/**
 * A `BrandError` is returned when a branded type is constructed from an invalid
 * value.
 *
 * @category models
 * @since 4.0.0
 */
export class BrandError {
  constructor(issue: Issue.Issue) {
    this.issue = issue
  }
  /**
   * @since 4.0.0
   */
  readonly _tag = "BrandError"
  /**
   * @since 4.0.0
   */
  readonly name: string = "BrandError"
  /**
   * @since 4.0.0
   */
  readonly issue: Issue.Issue
  /**
   * @since 4.0.0
   */
  get message() {
    return this.issue.toString()
  }
  /**
   * @since 4.0.0
   */
  toString() {
    return `BrandError(${this.message})`
  }
}

/**
 * @since 2.0.0
 */
export declare namespace Brand {
  /**
   * A utility type to extract a branded type from a `Constructor`.
   *
   * @since 2.0.0
   */
  export type FromConstructor<C> = C extends Constructor<infer B> ? B : never

  /**
   * A utility type to extract the unbranded value type from a brand.
   *
   * @since 2.0.0
   */
  export type Unbranded<B extends Brand<any>> = B extends infer U & Brands<B> ? U : B

  /**
   * A utility type to extract the keys of a branded type.
   *
   * @since 2.0.0
   */
  export type Keys<B extends Brand<any>> = keyof B[typeof TypeId]

  /**
   * A utility type to extract the brands from a branded type.
   *
   * @since 2.0.0
   */
  export type Brands<B extends Brand<any>> = Types.UnionToIntersection<
    { [K in Keys<B>]: K extends string ? Brand<K> : never }[Keys<B>]
  >

  /**
   * A utility type that checks that all brands have the same base type.
   *
   * @since 2.0.0
   */
  export type EnsureCommonBase<
    Brands extends readonly [Constructor<any>, ...Array<Constructor<any>>]
  > = {
    [B in keyof Brands]: Brand.Unbranded<Brand.FromConstructor<Brands[0]>> extends
      Brand.Unbranded<Brand.FromConstructor<Brands[B]>>
      ? Brand.Unbranded<Brand.FromConstructor<Brands[B]>> extends Brand.Unbranded<Brand.FromConstructor<Brands[0]>>
        ? Brands[B]
      : Brands[B]
      : "ERROR: All brands should have the same base type"
  }
}

/**
 * A type alias for creating branded types more concisely.
 *
 * @category alias
 * @since 2.0.0
 */
export type Branded<A, Key extends string> = A & Brand<Key>

/**
 * This function returns a `Constructor` that **does not apply any runtime
 * checks**, it just returns the provided value. It can be used to create
 * nominal types that allow distinguishing between two values of the same type
 * but with different meanings.
 *
 * If you also want to perform some validation, see {@link make} or
 * {@link check} or {@link refine}.
 *
 * @category constructors
 * @since 2.0.0
 */
export function nominal<A extends Brand<any>>(): Constructor<A> {
  return Object.assign((input: Brand.Unbranded<A>) => input as A, {
    option: (input: Brand.Unbranded<A>) => Option.some(input as A),
    result: (input: Brand.Unbranded<A>) => Result.succeed(input as A),
    is: (_: Brand.Unbranded<A>): _ is Brand.Unbranded<A> & A => true
  })
}

/**
 * Returns a `Constructor` that can construct a branded type from an
 * unbranded value using the provided `filter` predicate as validation of
 * the input data.
 *
 * If you don't want to perform any validation but only distinguish between two
 * values of the same type but with different meanings, see {@link nominal}.
 *
 * @category constructors
 * @since 2.0.0
 */
export function make<A extends Brand<any>>(
  filter: (unbranded: Brand.Unbranded<A>) => Schema.FilterOutput
): Constructor<A> {
  return check(AST.makeFilter(filter))
}

/**
 * @since 4.0.0
 */
export function check<A extends Brand<any>>(
  ...checks: readonly [
    AST.Check<Brand.Unbranded<A>>,
    ...Array<AST.Check<Brand.Unbranded<A>>>
  ]
): Constructor<A> {
  const result = (input: Brand.Unbranded<A>): Result.Result<A, BrandError> => {
    return Result.mapError(AST.runChecks(checks, input), (issue) => new BrandError(issue)) as any
  }
  return Object.assign((input: Brand.Unbranded<A>) => Result.getOrThrow(result(input)), {
    option: (input: Brand.Unbranded<A>) => Option.getSuccess(result(input)),
    result,
    is: (input: Brand.Unbranded<A>): input is Brand.Unbranded<A> & A => Result.isSuccess(result(input)),
    checks
  })
}

/**
 * Combines two or more brands together to form a single branded type. This API
 * is useful when you want to validate that the input data passes multiple brand
 * validators.
 *
 * @category combining
 * @since 2.0.0
 */
export function all<Brands extends readonly [Constructor<any>, ...Array<Constructor<any>>]>(
  ...brands: Brand.EnsureCommonBase<Brands>
): Constructor<
  Types.UnionToIntersection<{ [B in keyof Brands]: Brand.FromConstructor<Brands[B]> }[number]> extends
    infer X extends Brand<any> ? X : Brand<any>
> {
  const checks = brands.flatMap((brand) => brand.checks ?? [])
  return Arr.isArrayNonEmpty(checks) ?
    check(...checks) :
    nominal()
}
