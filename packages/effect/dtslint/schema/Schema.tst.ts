import type { SchemaAST } from "effect"
import {
  Brand,
  Effect,
  hole,
  Option,
  Predicate,
  Schema,
  SchemaGetter,
  SchemaTransformation,
  ServiceMap,
  Struct,
  Tuple
} from "effect"
import { immerable, produce } from "immer"
import { describe, expect, it, when } from "tstyche"

type MakeUnsafe<In, Out> = (input: In, options?: Schema.MakeOptions | undefined) => Out

const revealClass = <Self, S extends Schema.Struct<Schema.Struct.Fields>, Inherited>(
  klass: Schema.Class<Self, S, Inherited>
): Schema.Class<Self, S, Inherited> => klass

describe("Schema", () => {
  describe("variance", () => {
    it("Type", () => {
      const f1 = hole<
        <A extends string, S extends Schema.Codec<A, unknown, unknown>>(schema: S) => S
      >()
      const f2 = hole<
        <S extends Schema.Codec<string, unknown, unknown>>(schema: S) => S
      >()

      const schema = hole<Schema.Codec<"a", number, "ctx">>()

      f1(schema)
      f2(schema)
    })

    it("Encoded", () => {
      const f1 = hole<
        <A extends number, S extends Schema.Codec<unknown, A, unknown>>(schema: S) => S
      >()
      const f2 = hole<
        <S extends Schema.Codec<unknown, number, unknown>>(schema: S) => S
      >()

      const schema = hole<Schema.Codec<string, 1, "ctx">>()

      f1(schema)
      f2(schema)
    })
  })

  describe("type helpers type safety", () => {
    it("Schema", () => {
      function f<S extends Schema.Schema<unknown>>(_s: S) {
        // @ts-expect-error Type 'null' is not assignable to type 'Type<S>'
        const Type: Schema.Schema.Type<S> = null
        return Type
      }
      f(Schema.String)
    })

    it("Codec", () => {
      function f<S extends Schema.Codec<unknown, unknown, unknown, unknown>>(_s: S) {
        // @ts-expect-error Type 'null' is not assignable to type 'Encoded<S>'
        const Encoded: Schema.Codec.Encoded<S> = null
        // @ts-expect-error Type 'null' is not assignable to type 'DecodingServices<S>'
        const DecodingServices: Schema.Codec.DecodingServices<S> = null
        // @ts-expect-error Type 'null' is not assignable to type 'EncodingServices<S>'
        const EncodingServices: Schema.Codec.EncodingServices<S> = null
        return { Encoded, DecodingServices, EncodingServices }
      }
      f(Schema.String)
    })
  })

  describe("makeUnsafe", () => {
    it("Never", () => {
      const schema = Schema.Never
      expect(schema.makeUnsafe).type.toBe<MakeUnsafe<never, never>>()
    })

    it("Unknown", () => {
      const schema = Schema.Unknown
      expect(schema.makeUnsafe).type.toBe<MakeUnsafe<unknown, unknown>>()
    })

    it("Any", () => {
      const schema = Schema.Any
      expect(schema.makeUnsafe).type.toBe<MakeUnsafe<any, any>>()
    })

    it("Null", () => {
      const schema = Schema.Null
      expect(schema.makeUnsafe).type.toBe<MakeUnsafe<null, null>>()
    })

    it("Undefined", () => {
      const schema = Schema.Undefined
      expect(schema.makeUnsafe).type.toBe<MakeUnsafe<undefined, undefined>>()
    })

    it("String", () => {
      const schema = Schema.String
      expect(schema.makeUnsafe).type.toBe<MakeUnsafe<string, string>>()
    })

    it("Number", () => {
      const schema = Schema.Number
      expect(schema.makeUnsafe).type.toBe<MakeUnsafe<number, number>>()
    })

    it("check", () => {
      const schema = Schema.String.check(Schema.isMinLength(1))
      expect(schema.makeUnsafe).type.toBe<MakeUnsafe<string, string>>()
    })

    it("brand", () => {
      const schema = Schema.String.pipe(Schema.brand("a"))
      expect(schema.makeUnsafe).type.toBe<MakeUnsafe<string, string & Brand.Brand<"a">>>()
      expect(schema).type.toBe<Schema.brand<Schema.String, "a">>()
      expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<string & Brand.Brand<"a">, string, never, never>>()
    })

    it("refine", () => {
      const schema = Schema.Option(Schema.String).pipe(Schema.refine(Option.isSome))
      expect(schema.makeUnsafe).type.toBe<MakeUnsafe<Option.Option<string>, Option.Some<string>>>()
    })

    describe("Struct", () => {
      it("simple field", () => {
        const schema = Schema.Struct({
          a: Schema.String
        })
        expect(schema.makeUnsafe).type.toBe<MakeUnsafe<{ readonly a: string }, { readonly a: string }>>()
      })

      it("branded field", () => {
        const schema = Schema.Struct({
          a: Schema.String.pipe(Schema.brand("a"))
        })
        expect(schema.makeUnsafe).type.toBe<
          MakeUnsafe<{ readonly a: string & Brand.Brand<"a"> }, { readonly a: string & Brand.Brand<"a"> }>
        >()
      })

      it("refine field", () => {
        const schema = Schema.Struct({
          a: Schema.Option(Schema.String).pipe(Schema.refine(Option.isSome))
        })
        expect(schema.makeUnsafe).type.toBe<
          MakeUnsafe<{ readonly a: Option.Some<string> }, { readonly a: Option.Some<string> }>
        >()
      })

      it("defaulted field", () => {
        const schema = Schema.Struct({
          a: Schema.String.pipe(Schema.withConstructorDefault(() => Option.some("default")))
        })
        expect(schema.makeUnsafe).type.toBe<MakeUnsafe<{ readonly a?: string }, { readonly a: string }>>()
      })

      it("branded defaulted field", () => {
        const schema = Schema.Struct({
          a: Schema.String.pipe(Schema.brand("a"), Schema.withConstructorDefault(() => Option.some("default")))
        })
        expect(schema.makeUnsafe).type.toBe<
          MakeUnsafe<{ readonly a?: string & Brand.Brand<"a"> }, { readonly a: string & Brand.Brand<"a"> }>
        >()
      })

      it("defaulted branded field", () => {
        const schema = Schema.Struct({
          a: Schema.String.pipe(Schema.withConstructorDefault(() => Option.some("default")), Schema.brand("a"))
        })
        expect(schema.makeUnsafe).type.toBe<
          MakeUnsafe<{ readonly a?: string & Brand.Brand<"a"> }, { readonly a: string & Brand.Brand<"a"> }>
        >()
      })

      it("nested defaulted fields", () => {
        const schema = Schema.Struct({
          a: Schema.Struct({
            b: Schema.Finite.pipe(Schema.withConstructorDefault(() => Option.some(-1)))
          }).pipe(Schema.withConstructorDefault(() => Option.some({})))
        })
        expect(schema.makeUnsafe).type.toBe<
          MakeUnsafe<{ readonly a?: { readonly b?: number } }, { readonly a: { readonly b: number } }>
        >()
      })

      it("nested defaulted & branded field", () => {
        const A = Schema.Struct({
          b: Schema.Finite.pipe(Schema.withConstructorDefault(() => Option.some(-1)))
        }).pipe(Schema.brand("a"))
        const schema = Schema.Struct({
          a: A.pipe(Schema.withConstructorDefault(() => Option.some(A.makeUnsafe({}))))
        })
        expect(schema.makeUnsafe).type.toBe<
          MakeUnsafe<
            { readonly a?: { readonly b: number } & Brand.Brand<"a"> },
            { readonly a: { readonly b: number } & Brand.Brand<"a"> }
          >
        >()
      })

      it("Class field", () => {
        class A extends Schema.Class<A, { readonly brand: unique symbol }>("A")(Schema.Struct({
          a: Schema.String
        })) {}
        const schema = Schema.Struct({
          a: A
        })
        expect(schema.makeUnsafe).type.toBe<MakeUnsafe<{ readonly a: A }, { readonly a: A }>>()
      })

      it("optional Class field", () => {
        class A extends Schema.Class<A, { readonly brand: unique symbol }>("A")(Schema.Struct({
          a: Schema.String
        })) {}
        const schema = Schema.Struct({
          a: A.pipe(Schema.withConstructorDefault(() => Option.some(new A({ a: "default" }))))
        })
        expect(schema.makeUnsafe).type.toBe<MakeUnsafe<{ readonly a?: A }, { readonly a: A }>>()
      })
    })

    describe("Tuple", () => {
      it("simple element", () => {
        const schema = Schema.Tuple([Schema.String])
        expect(schema.makeUnsafe).type.toBe<MakeUnsafe<readonly [string], readonly [string]>>()
      })

      it("branded field", () => {
        const schema = Schema.Tuple([Schema.String.pipe(Schema.brand("a"))])
        expect(schema.makeUnsafe).type.toBe<
          MakeUnsafe<readonly [string & Brand.Brand<"a">], readonly [string & Brand.Brand<"a">]>
        >()
      })

      it("defaulted field", () => {
        const schema = Schema.Tuple([Schema.String.pipe(Schema.withConstructorDefault(() => Option.some("default")))])
        expect(schema.makeUnsafe).type.toBe<MakeUnsafe<readonly [string?], readonly [string]>>()
      })

      it("nested defaults (Struct)", () => {
        const schema = Schema.Tuple(
          [
            Schema.Struct({
              b: Schema.FiniteFromString.pipe(Schema.withConstructorDefault(() => Option.some(-1)))
            }).pipe(Schema.withConstructorDefault(() => Option.some({})))
          ]
        )
        expect(schema.makeUnsafe).type.toBe<
          MakeUnsafe<readonly [{ readonly b?: number }?], readonly [{ readonly b: number }]>
        >()
      })

      it("nested defaults (Tuple)", () => {
        const schema = Schema.Tuple(
          [
            Schema.Tuple([
              Schema.FiniteFromString.pipe(Schema.withConstructorDefault(() => Option.some(-1)))
            ]).pipe(Schema.withConstructorDefault(() => Option.some([] as const)))
          ]
        )
        expect(schema.makeUnsafe).type.toBe<
          MakeUnsafe<readonly [(readonly [number?])?], readonly [readonly [number]]>
        >()
      })
    })

    describe("Class", () => {
      it("nested defaulted fields", () => {
        class A extends Schema.Class<A, { readonly brand: unique symbol }>("A")(Schema.Struct({
          a: Schema.Struct({
            b: Schema.Finite.pipe(Schema.withConstructorDefault(() => Option.some(-1)))
          }).pipe(Schema.withConstructorDefault(() => Option.some({})))
        })) {}
        expect(A.makeUnsafe).type.toBe<MakeUnsafe<{ readonly a?: { readonly b?: number } }, A>>()
        const schema = Schema.Struct({
          a: A
        })
        expect(schema.makeUnsafe).type.toBe<MakeUnsafe<{ readonly a: A }, { readonly a: A }>>()
      })
    })

    it("toType", () => {
      const schema = Schema.toType(Schema.FiniteFromString)
      expect(schema.makeUnsafe).type.toBe<MakeUnsafe<number, number>>()
    })

    it("toEncoded", () => {
      const schema = Schema.toEncoded(Schema.FiniteFromString)
      expect(schema.makeUnsafe).type.toBe<MakeUnsafe<string, string>>()
    })

    it("flip", () => {
      const schema = Schema.Struct({
        a: Schema.FiniteFromString
      })
      const flipped = Schema.flip(schema)
      expect(flipped.makeUnsafe).type.toBe<MakeUnsafe<{ readonly a: string }, { readonly a: string }>>()
    })

    it("Array", () => {
      const schema = Schema.Array(Schema.FiniteFromString.pipe(Schema.brand("a")))
      expect(schema.makeUnsafe).type.toBe<
        MakeUnsafe<ReadonlyArray<number & Brand.Brand<"a">>, ReadonlyArray<number & Brand.Brand<"a">>>
      >()
    })

    it("NonEmptyArray", () => {
      const schema = Schema.NonEmptyArray(Schema.FiniteFromString.pipe(Schema.brand("a")))
      expect(schema.makeUnsafe).type.toBe<
        MakeUnsafe<
          readonly [number & Brand.Brand<"a">, ...Array<number & Brand.Brand<"a">>],
          readonly [number & Brand.Brand<"a">, ...Array<number & Brand.Brand<"a">>]
        >
      >()
    })

    it("Record", () => {
      const schema = Schema.Record(
        Schema.String.pipe(Schema.brand("k")),
        Schema.FiniteFromString.pipe(Schema.brand("a"))
      )

      expect(schema.makeUnsafe).type.toBe<
        MakeUnsafe<
          { readonly [x: string & Brand.Brand<"k">]: number & Brand.Brand<"a"> },
          { readonly [x: string & Brand.Brand<"k">]: number & Brand.Brand<"a"> }
        >
      >()
    })

    it("StructWithRest", () => {
      const schema = Schema.StructWithRest(
        Schema.Struct({ a: Schema.FiniteFromString.pipe(Schema.brand("a")) }),
        [Schema.Record(Schema.String.pipe(Schema.brand("k")), Schema.FiniteFromString.pipe(Schema.brand("a")))]
      )
      expect(schema.makeUnsafe).type.toBe<
        MakeUnsafe<{
          readonly [x: string & Brand.Brand<"k">]: number & Brand.Brand<"a">
          readonly a: number & Brand.Brand<"a">
        }, {
          readonly [x: string & Brand.Brand<"k">]: number & Brand.Brand<"a">
          readonly a: number & Brand.Brand<"a">
        }>
      >()
    })

    it("TupleWithRest", () => {
      const schema = Schema.TupleWithRest(
        Schema.Tuple([Schema.FiniteFromString.pipe(Schema.brand("a"))]),
        [Schema.FiniteFromString.pipe(Schema.brand("b")), Schema.FiniteFromString.pipe(Schema.brand("c"))]
      )
      expect(schema.makeUnsafe).type.toBe<
        MakeUnsafe<
          readonly [number & Brand.Brand<"a">, ...Array<number & Brand.Brand<"b">>, number & Brand.Brand<"c">],
          readonly [number & Brand.Brand<"a">, ...Array<number & Brand.Brand<"b">>, number & Brand.Brand<"c">]
        >
      >()
    })

    it("Union", () => {
      const schema = Schema.Union([
        Schema.Array(Schema.FiniteFromString.pipe(Schema.brand("a"))),
        Schema.FiniteFromString.pipe(Schema.brand("b"))
      ])
      expect(schema.makeUnsafe).type.toBe<
        MakeUnsafe<
          ReadonlyArray<number & Brand.Brand<"a">> | number & Brand.Brand<"b">,
          ReadonlyArray<number & Brand.Brand<"a">> | number & Brand.Brand<"b">
        >
      >()
    })

    it("Opaque", () => {
      class A extends Schema.Opaque<A>()(
        Schema.Struct({
          b: Schema.FiniteFromString.pipe(Schema.brand("a"), Schema.withConstructorDefault(() => Option.some(-1)))
        })
      ) {}
      const schema = Schema.Struct({
        a: A
      })

      expect(schema.makeUnsafe).type.toBe<
        MakeUnsafe<{ readonly a: { readonly b?: number & Brand.Brand<"a"> } }, { readonly a: A }>
      >()
    })
  })

  describe("typeCodec", () => {
    it("ast type", () => {
      const schema = Schema.toType(Schema.FiniteFromString)
      expect(schema.ast).type.toBe<SchemaAST.Number>()
    })

    it("revealCodec + annotate", () => {
      const schema = Schema.toType(Schema.FiniteFromString)
      expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<number, number, never, never>>()
      expect(schema).type.toBe<Schema.toType<Schema.FiniteFromString>>()
      expect(schema.annotate({})).type.toBe<Schema.toType<Schema.FiniteFromString>>()
    })
  })

  describe("encodedCodec", () => {
    it("ast type", () => {
      const schema = Schema.FiniteFromString
      expect(schema.ast).type.toBe<SchemaAST.Number>()
    })

    it("revealCodec + annotate", () => {
      const schema = Schema.toEncoded(Schema.FiniteFromString)
      expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<string, string, never, never>>()
      expect(schema).type.toBe<Schema.toEncoded<Schema.FiniteFromString>>()
      expect(schema.annotate({})).type.toBe<Schema.toEncoded<Schema.FiniteFromString>>()
    })
  })

  it("annotateKey", () => {
    expect(Schema.String.annotateKey).type.toBeCallableWith(
      { examples: ["a"] }
    )
    expect(Schema.String.annotateKey).type.not.toBeCallableWith(
      { examples: [1] }
    )
    expect(Schema.String.annotateKey).type.toBeCallableWith(
      { default: "a" }
    )
    expect(Schema.String.annotateKey).type.not.toBeCallableWith(
      { default: 1 }
    )
  })

  describe("Never", () => {
    const schema = Schema.Never

    it("ast type", () => {
      expect(schema.ast).type.toBe<SchemaAST.Never>()
    })

    it("revealCodec + annotate", () => {
      expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<never>>()
      expect(schema).type.toBe<Schema.Never>()
      expect(schema.annotate({})).type.toBe<Schema.Never>()
    })
  })

  describe("Unknown", () => {
    const schema = Schema.Unknown

    it("ast type", () => {
      expect(schema.ast).type.toBe<SchemaAST.Unknown>()
    })

    it("revealCodec + annotate", () => {
      expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<unknown>>()
      expect(schema).type.toBe<Schema.Unknown>()
      expect(schema.annotate({})).type.toBe<Schema.Unknown>()
    })
  })

  describe("Null", () => {
    const schema = Schema.Null

    it("ast type", () => {
      expect(schema.ast).type.toBe<SchemaAST.Null>()
    })

    it("revealCodec + annotate", () => {
      expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<null>>()
      expect(schema).type.toBe<Schema.Null>()
      expect(schema.annotate({})).type.toBe<Schema.Null>()
    })
  })

  describe("Undefined", () => {
    const schema = Schema.Undefined

    it("ast type", () => {
      expect(schema.ast).type.toBe<SchemaAST.Undefined>()
    })

    it("revealCodec + annotate", () => {
      expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<undefined>>()
      expect(schema).type.toBe<Schema.Undefined>()
      expect(schema.annotate({})).type.toBe<Schema.Undefined>()
    })
  })

  describe("String", () => {
    const schema = Schema.String

    it("ast type", () => {
      expect(schema.ast).type.toBe<SchemaAST.String>()
    })

    it("revealCodec + annotate", () => {
      expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<string>>()
      expect(schema).type.toBe<Schema.String>()
      expect(schema.annotate({})).type.toBe<Schema.String>()
    })
  })

  describe("Number", () => {
    const schema = Schema.Number

    it("ast type", () => {
      expect(schema.ast).type.toBe<SchemaAST.Number>()
    })

    it("revealCodec + annotate", () => {
      expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<number>>()
      expect(schema).type.toBe<Schema.Number>()
      expect(schema.annotate({})).type.toBe<Schema.Number>()
    })
  })

  describe("Literal", () => {
    it("ast type", () => {
      const schema = Schema.Literal("a")
      expect(schema.ast).type.toBe<SchemaAST.Literal>()
    })

    it("revealCodec + annotate", () => {
      const schema = Schema.Literal("a")
      expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<"a">>()
      expect(schema).type.toBe<Schema.Literal<"a">>()
      expect(schema.annotate({})).type.toBe<Schema.Literal<"a">>()
    })

    it("transform", () => {
      const schema = Schema.Literal(0).transform("a")
      expect(schema).type.toBe<Schema.decodeTo<Schema.Literal<"a">, Schema.Literal<0>>>()
    })
  })

  it("TemplateLiteral", () => {
    expect(Schema.TemplateLiteral).type.not.toBeCallableWith([Schema.Null])
    expect(Schema.TemplateLiteral).type.not.toBeCallableWith([Schema.Undefined])
    expect(Schema.TemplateLiteral).type.not.toBeCallableWith([Schema.Boolean])
    expect(Schema.TemplateLiteral).type.not.toBeCallableWith([Schema.Date])

    expect(Schema.TemplateLiteral(["a"])["Encoded"])
      .type.toBe<`a`>()
    expect(Schema.TemplateLiteral([Schema.Literal("a")])["Encoded"])
      .type.toBe<`a`>()
    expect(Schema.TemplateLiteral([1])["Encoded"])
      .type.toBe<`1`>()
    expect(Schema.TemplateLiteral([Schema.Literal(1)])["Encoded"])
      .type.toBe<`1`>()
    expect(Schema.TemplateLiteral([Schema.String])["Encoded"])
      .type.toBe<`${string}`>()
    expect(Schema.TemplateLiteral([Schema.Number])["Encoded"])
      .type.toBe<`${number}`>()
    expect(Schema.TemplateLiteral(["a", "b"])["Encoded"])
      .type.toBe<`ab`>()
    expect(Schema.TemplateLiteral([Schema.Literal("a"), Schema.Literal("b")])["Encoded"])
      .type.toBe<`ab`>()
    expect(Schema.TemplateLiteral(["a", Schema.String])["Encoded"])
      .type.toBe<`a${string}`>()
    expect(Schema.TemplateLiteral([Schema.Literal("a"), Schema.String])["Encoded"])
      .type.toBe<`a${string}`>()
    expect(Schema.TemplateLiteral(["a", Schema.Number])["Encoded"])
      .type.toBe<`a${number}`>()
    expect(Schema.TemplateLiteral([Schema.Literal("a"), Schema.Number])["Encoded"])
      .type.toBe<`a${number}`>()
    expect(Schema.TemplateLiteral([Schema.String, "a"])["Encoded"])
      .type.toBe<`${string}a`>()
    expect(Schema.TemplateLiteral([Schema.String, Schema.Literal("a")])["Encoded"])
      .type.toBe<`${string}a`>()
    expect(Schema.TemplateLiteral([Schema.Number, "a"])["Encoded"])
      .type.toBe<`${number}a`>()
    expect(Schema.TemplateLiteral([Schema.Number, Schema.Literal("a")])["Encoded"])
      .type.toBe<`${number}a`>()
    expect(Schema.TemplateLiteral([Schema.String, 0])["Encoded"])
      .type.toBe<`${string}0`>()
    expect(Schema.TemplateLiteral([Schema.String, 1n])["Encoded"])
      .type.toBe<`${string}1`>()
    expect(Schema.TemplateLiteral([Schema.String, Schema.Literals(["a", 0])])["Encoded"])
      .type.toBe<`${string}a` | `${string}0`>()
    expect(Schema.TemplateLiteral([Schema.String, Schema.Literal("/"), Schema.Number])["Encoded"])
      .type.toBe<`${string}/${number}`>()
    const EmailLocaleIDs = Schema.Literals(["welcome_email", "email_heading"])
    const FooterLocaleIDs = Schema.Literals(["footer_title", "footer_sendoff"])
    expect(
      Schema.revealCodec(Schema.TemplateLiteral([
        Schema.Union([EmailLocaleIDs, FooterLocaleIDs]),
        Schema.Literal("_id")
      ]))
    )
      .type.toBe<
      Schema.Codec<
        "welcome_email_id" | "email_heading_id" | "footer_title_id" | "footer_sendoff_id",
        "welcome_email_id" | "email_heading_id" | "footer_title_id" | "footer_sendoff_id",
        never
      >
    >()
    expect(Schema.TemplateLiteral([Schema.Union([EmailLocaleIDs, FooterLocaleIDs]), Schema.Literal("_id")])["Encoded"])
      .type.toBe<
      "welcome_email_id" | "email_heading_id" | "footer_title_id" | "footer_sendoff_id"
    >()
    expect(Schema.TemplateLiteral(["a", Schema.Union([Schema.Number, Schema.String])])["Encoded"])
      .type.toBe<`a${string}` | `a${number}`>()
    expect(Schema.TemplateLiteral(["a", Schema.FiniteFromString])["Encoded"])
      .type.toBe<`a${string}`>()
  })

  it("TemplateLiteralParser", () => {
    expect(Schema.revealCodec(Schema.TemplateLiteralParser(["a"])))
      .type.toBe<Schema.Codec<readonly ["a"], "a">>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.Literal("a")])))
      .type.toBe<Schema.Codec<readonly ["a"], "a">>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([1])))
      .type.toBe<Schema.Codec<readonly [1], "1">>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.Literal(1)])))
      .type.toBe<Schema.Codec<readonly [1], "1">>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.String])))
      .type.toBe<Schema.Codec<readonly [string], string>>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.Number])))
      .type.toBe<Schema.Codec<readonly [number], `${number}`>>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser(["a", "b"])))
      .type.toBe<Schema.Codec<readonly ["a", "b"], "ab">>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.Literal("a"), Schema.Literal("b")])))
      .type.toBe<Schema.Codec<readonly ["a", "b"], "ab">>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser(["a", Schema.String])))
      .type.toBe<Schema.Codec<readonly ["a", string], `a${string}`>>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.Literal("a"), Schema.String])))
      .type.toBe<Schema.Codec<readonly ["a", string], `a${string}`>>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser(["a", Schema.Number])))
      .type.toBe<Schema.Codec<readonly ["a", number], `a${number}`>>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.Literal("a"), Schema.Number])))
      .type.toBe<Schema.Codec<readonly ["a", number], `a${number}`>>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.String, "a"])))
      .type.toBe<Schema.Codec<readonly [string, "a"], `${string}a`>>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.String, Schema.Literal("a")])))
      .type.toBe<Schema.Codec<readonly [string, "a"], `${string}a`>>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.Number, "a"])))
      .type.toBe<Schema.Codec<readonly [number, "a"], `${number}a`>>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.Number, Schema.Literal("a")])))
      .type.toBe<Schema.Codec<readonly [number, "a"], `${number}a`>>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.String, 0])))
      .type.toBe<Schema.Codec<readonly [string, 0], `${string}0`>>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.String, "true"])))
      .type.toBe<Schema.Codec<readonly [string, "true"], `${string}true`>>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.String, "null"])))
      .type.toBe<Schema.Codec<readonly [string, "null"], `${string}null`>>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.String, 1n])))
      .type.toBe<Schema.Codec<readonly [string, 1n], `${string}1`>>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.String, Schema.Literals(["a", 0])])))
      .type.toBe<Schema.Codec<readonly [string, 0 | "a"], `${string}a` | `${string}0`>>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.String, Schema.Literal("/"), Schema.Number])))
      .type.toBe<Schema.Codec<readonly [string, "/", number], `${string}/${number}`>>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.String, "/", Schema.Number])))
      .type.toBe<Schema.Codec<readonly [string, "/", number], `${string}/${number}`>>()
    const EmailLocaleIDs = Schema.Literals(["welcome_email", "email_heading"])
    const FooterLocaleIDs = Schema.Literals(["footer_title", "footer_sendoff"])
    expect(
      Schema.revealCodec(
        Schema.TemplateLiteralParser([Schema.Union([EmailLocaleIDs, FooterLocaleIDs]), Schema.Literal("_id")])
      )
    )
      .type.toBe<
      Schema.Codec<
        readonly ["welcome_email" | "email_heading" | "footer_title" | "footer_sendoff", "_id"],
        "welcome_email_id" | "email_heading_id" | "footer_title_id" | "footer_sendoff_id",
        never
      >
    >()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.Union([EmailLocaleIDs, FooterLocaleIDs]), "_id"])))
      .type.toBe<
      Schema.Codec<
        readonly ["welcome_email" | "email_heading" | "footer_title" | "footer_sendoff", "_id"],
        "welcome_email_id" | "email_heading_id" | "footer_title_id" | "footer_sendoff_id",
        never
      >
    >()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.String.pipe(Schema.brand("MyBrand"))])))
      .type.toBe<Schema.Codec<readonly [string & Brand.Brand<"MyBrand">], string>>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser([Schema.Number.pipe(Schema.brand("MyBrand"))])))
      .type.toBe<Schema.Codec<readonly [number & Brand.Brand<"MyBrand">], `${number}`>>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser(["a", Schema.String.pipe(Schema.brand("MyBrand"))])))
      .type.toBe<Schema.Codec<readonly ["a", string & Brand.Brand<"MyBrand">], `a${string}`>>()
    expect(
      Schema.revealCodec(
        Schema.TemplateLiteralParser([Schema.Literal("a"), Schema.String.pipe(Schema.brand("MyBrand"))])
      )
    )
      .type.toBe<Schema.Codec<readonly ["a", string & Brand.Brand<"MyBrand">], `a${string}`>>()
    expect(
      Schema.revealCodec(
        Schema.TemplateLiteralParser([
          Schema.Literal("a").pipe(Schema.brand("L")),
          Schema.String.pipe(Schema.brand("MyBrand"))
        ])
      )
    ).type.toBe<
      Schema.Codec<readonly [("a" & Brand.Brand<"L">), string & Brand.Brand<"MyBrand">], `a${string}`>
    >()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser(["a", Schema.Number.pipe(Schema.brand("MyBrand"))])))
      .type.toBe<Schema.Codec<readonly ["a", number & Brand.Brand<"MyBrand">], `a${number}`>>()
    expect(
      Schema.revealCodec(
        Schema.TemplateLiteralParser([Schema.Literal("a"), Schema.Number.pipe(Schema.brand("MyBrand"))])
      )
    )
      .type.toBe<Schema.Codec<readonly ["a", number & Brand.Brand<"MyBrand">], `a${number}`>>()
    expect(Schema.revealCodec(Schema.TemplateLiteralParser(["a", Schema.Union([Schema.Number, Schema.String])])))
      .type.toBe<Schema.Codec<readonly ["a", string | number], `a${string}` | `a${number}`>>()
  })

  describe("flip", () => {
    it("applying flip twice should return the original schema", () => {
      const schema = Schema.FiniteFromString
      expect(Schema.flip(Schema.flip(schema))).type.toBe<typeof schema>()
    })

    it("decodeTo", () => {
      const schema = Schema.FiniteFromString
      const flipped = Schema.flip(schema)
      expect(flipped).type.toBe<Schema.flip<Schema.decodeTo<Schema.Number, Schema.String>>>()
      expect(flipped.annotate({})).type.toBe<Schema.flip<Schema.decodeTo<Schema.Number, Schema.String>>>()
      expect(Schema.revealCodec(flipped)).type.toBe<Schema.Codec<string, number>>()
      expect(Schema.revealCodec(flipped.annotate({}))).type.toBe<Schema.Codec<string, number>>()
    })

    it("optionalKey", () => {
      const schema = Schema.Struct({
        a: Schema.optionalKey(Schema.FiniteFromString)
      })
      const flipped = Schema.flip(schema)
      expect(Schema.revealCodec(flipped)).type.toBe<Schema.Codec<{ readonly a?: string }, { readonly a?: number }>>()
    })

    it("optional", () => {
      const schema = Schema.Struct({
        a: Schema.optional(Schema.FiniteFromString)
      })
      const flipped = Schema.flip(schema)
      expect(Schema.revealCodec(flipped)).type.toBe<
        Schema.Codec<{ readonly a?: string | undefined }, { readonly a?: number | undefined }>
      >()
    })

    it("Struct & withConstructorDefault", () => {
      const schema = Schema.Struct({
        a: Schema.String.pipe(Schema.withConstructorDefault(() => Option.some("c")))
      })
      expect(schema.makeUnsafe).type.toBe<
        (input: { readonly a?: string }, options?: Schema.MakeOptions | undefined) => { readonly a: string }
      >()

      const flipped = schema.pipe(Schema.flip)
      expect(flipped.makeUnsafe).type.toBe<
        (input: { readonly a: string }, options?: Schema.MakeOptions | undefined) => { readonly a: string }
      >()
    })
  })

  describe("checks", () => {
    describe("and / annotate", () => {
      it("Filter + Filter", () => {
        const f1 = Schema.isInt()
        const f2 = Schema.isInt()

        expect(f1.and(f2)).type.toBe<SchemaAST.FilterGroup<number>>()
        expect(f1.and(f2).annotate({})).type.toBe<SchemaAST.FilterGroup<number>>()
      })

      it("Filter + FilterGroup", () => {
        const f1 = Schema.isInt()
        const f2 = Schema.isInt32()

        expect(f1.and(f2)).type.toBe<SchemaAST.FilterGroup<number>>()
        expect(f2.and(f1)).type.toBe<SchemaAST.FilterGroup<number>>()
        expect(f1.and(f2).annotate({})).type.toBe<SchemaAST.FilterGroup<number>>()
        expect(f2.and(f1).annotate({})).type.toBe<SchemaAST.FilterGroup<number>>()
      })

      it("FilterGroup + FilterGroup", () => {
        const f1 = Schema.isInt32()
        const f2 = Schema.isInt32()

        expect(f1.and(f2)).type.toBe<SchemaAST.FilterGroup<number>>()
        expect(f2.and(f1)).type.toBe<SchemaAST.FilterGroup<number>>()
        expect(f1.and(f2).annotate({})).type.toBe<SchemaAST.FilterGroup<number>>()
        expect(f2.and(f1).annotate({})).type.toBe<SchemaAST.FilterGroup<number>>()
      })
    })
  })

  describe("refinements", () => {
    describe("refine", () => {
      it("String & isString", () => {
        const schema = Schema.String.pipe(Schema.refine(Predicate.isString))
        expect(Schema.revealCodec(schema)).type.toBe<
          Schema.Codec<string, string, never, never>
        >()
      })

      it("String | Number & isString", () => {
        const schema = Schema.Union([Schema.String, Schema.Number]).pipe(
          Schema.refine(Predicate.isString)
        )
        expect(Schema.revealCodec(schema)).type.toBe<
          Schema.Codec<string, string | number, never, never>
        >()
      })

      it("Option(String) & isSome", () => {
        const schema = Schema.Option(Schema.String).pipe(Schema.refine(Option.isSome))
        expect(Schema.revealCodec(schema)).type.toBe<
          Schema.Codec<Option.Some<string>, Option.Option<string>, never, never>
        >()
        expect(schema).type.toBe<Schema.refine<Option.Some<string>, Schema.Option<Schema.String>>>()
        expect(schema.annotate({})).type.toBe<
          Schema.refine<Option.Some<string>, Schema.Option<Schema.String>>
        >()
      })
    })

    describe("brand", () => {
      it("single brand", () => {
        const schema = Schema.String.pipe(Schema.brand("a"))
        expect(Schema.revealCodec(schema)).type.toBe<
          Schema.Codec<string & Brand.Brand<"a">, string, never, never>
        >()
      })

      it("double brand", () => {
        const schema = Schema.String.pipe(Schema.brand("a"), Schema.brand("b"))

        expect(Schema.revealCodec(schema)).type.toBe<
          Schema.Codec<string & Brand.Brand<"a"> & Brand.Brand<"b">, string, never, never>
        >()
      })
    })
  })

  it("instanceOf", () => {
    class MyError extends Error {
      constructor(message?: string) {
        super(message)
        this.name = "MyError"
        Object.setPrototypeOf(this, MyError.prototype)
      }
    }

    const schema = Schema.instanceOf(MyError)

    expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<MyError, MyError, never, never>>()
    expect(schema).type.toBe<Schema.instanceOf<MyError>>()
    expect(schema.annotate({})).type.toBe<Schema.instanceOf<MyError>>()
    expect(schema.ast).type.toBe<SchemaAST.Declaration>()
    expect(schema.makeUnsafe).type.toBe<
      (input: MyError, options?: Schema.MakeOptions | undefined) => MyError
    >()
  })

  describe("decodeTo", () => {
    it("should allow partial application", () => {
      const f = Schema.decodeTo(Schema.String)
      expect(f).type.toBe<
        <From extends Schema.Top>(from: From) => Schema.compose<Schema.String, From>
      >()

      expect(f(Schema.Number)).type.toBe<Schema.compose<Schema.String, Schema.Number>>()
    })
  })

  describe("passthrough", () => {
    it("E = T", () => {
      Schema.String.pipe(
        Schema.decodeTo(
          Schema.NonEmptyString,
          SchemaTransformation.passthrough()
        )
      )
    })

    it("E != T", () => {
      when(Schema.String.pipe).isCalledWith(
        expect(Schema.decodeTo).type.not.toBeCallableWith(
          Schema.Number,
          SchemaTransformation.passthrough()
        )
      )

      Schema.String.pipe(
        Schema.decodeTo(
          Schema.Number,
          SchemaTransformation.passthrough({ strict: false })
        )
      )
    })

    it("E extends T", () => {
      Schema.String.pipe(
        Schema.decodeTo(
          Schema.UndefinedOr(Schema.String),
          SchemaTransformation.passthroughSubtype()
        )
      )
    })

    it("T extends E", () => {
      Schema.UndefinedOr(Schema.String).pipe(
        Schema.decodeTo(
          Schema.String,
          SchemaTransformation.passthroughSupertype()
        )
      )
    })
  })

  it("optionalKey", () => {
    {
      const schema = Schema.optionalKey(Schema.String)
      expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<string, string, never>>()
      expect(schema).type.toBe<Schema.optionalKey<Schema.String>>()
      expect(schema.schema).type.toBe<Schema.String>()
      expect(schema.annotate({})).type.toBe<Schema.optionalKey<Schema.String>>()
    }

    {
      const schema = Schema.String.pipe(Schema.optionalKey)
      expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<string, string, never>>()
    }
  })

  it("optional", () => {
    {
      const schema = Schema.optional(Schema.String)
      expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<string | undefined, string | undefined, never>>()
      expect(schema).type.toBe<Schema.optional<Schema.String>>()
      expect(schema.schema).type.toBe<Schema.UndefinedOr<Schema.String>>()
      expect(schema.annotate({})).type.toBe<Schema.optional<Schema.String>>()
    }

    {
      const schema = Schema.String.pipe(Schema.optional)
      expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<string | undefined, string | undefined, never>>()
    }
  })

  it("mutableKey", () => {
    {
      const schema = Schema.mutableKey(Schema.String)
      expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<string, string, never>>()
      expect(schema).type.toBe<Schema.mutableKey<Schema.String>>()
      expect(schema.schema).type.toBe<Schema.String>()
      expect(schema.annotate({})).type.toBe<Schema.mutableKey<Schema.String>>()
    }

    {
      const schema = Schema.String.pipe(Schema.mutableKey)
      expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<string, string, never>>()
    }
  })

  describe("readonlyKey", () => {
    it("should not be callable with a schema without Schema.mutableKey{Key,}", () => {
      expect(Schema.readonlyKey).type.not.toBeCallableWith(Schema.String)
    })

    it("should be callable with a schema with Schema.mutableKey", () => {
      const schema = Schema.readonlyKey(Schema.mutableKey(Schema.String))
      expect(schema).type.toBe<Schema.String>()
    })

    it("top level call", () => {
      {
        const schema = Schema.readonlyKey(Schema.mutableKey(Schema.String))
        expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<string, string, never>>()
        expect(schema).type.toBe<Schema.String>()
      }

      {
        const schema = Schema.mutableKey(Schema.String).pipe(Schema.readonlyKey)
        expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<string, string, never>>()
        expect(schema).type.toBe<Schema.String>()
      }
    })

    it("mapFields should throw an error if there is a field with no Schema.mutableKey", () => {
      expect(
        Schema.Struct({
          a: Schema.String
        }).mapFields
      ).type.not.toBeCallableWith(Struct.map(Schema.readonlyKey))
    })
  })

  describe("mutable", () => {
    it("should not be callable with a non-array schema", () => {
      expect(Schema.mutable).type.not.toBeCallableWith(Schema.Struct({ a: Schema.Number }))
      expect(Schema.mutable).type.not.toBeCallableWith(Schema.Record(Schema.String, Schema.Number))
    })

    it("mapFields should throw an error if there is a field that is not an array or tuple", () => {
      expect(
        Schema.Struct({
          a: Schema.String
        }).mapFields
      ).type.not.toBeCallableWith(Struct.map(Schema.mutable))
    })
  })

  describe("requiredKey", () => {
    it("should not be callable with a schema without Schema.optional{Key,}", () => {
      expect(Schema.requiredKey).type.not.toBeCallableWith(Schema.String)
    })

    it("should be callable with a schema with Schema.optionalKey", () => {
      const schema = Schema.requiredKey(Schema.optionalKey(Schema.String))
      expect(schema).type.toBe<Schema.String>()
    })

    it("should be callable with a schema with Schema.optional", () => {
      const schema = Schema.requiredKey(Schema.optional(Schema.String))
      expect(schema).type.toBe<Schema.UndefinedOr<Schema.String>>()
    })

    it("top level call", () => {
      {
        const schema = Schema.requiredKey(Schema.optionalKey(Schema.String))
        expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<string, string, never>>()
        expect(schema).type.toBe<Schema.String>()
      }

      {
        const schema = Schema.optionalKey(Schema.String).pipe(Schema.requiredKey)
        expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<string, string, never>>()
        expect(schema).type.toBe<Schema.String>()
      }
    })

    it("mapFields should throw an error if there is a field with no Schema.optionalKey", () => {
      expect(
        Schema.Struct({
          a: Schema.String
        }).mapFields
      ).type.not.toBeCallableWith(Struct.map(Schema.requiredKey))
    })
  })

  describe("required", () => {
    it("should not be callable with a schema without Schema.optional", () => {
      expect(Schema.required).type.not.toBeCallableWith(Schema.String)
      expect(Schema.required).type.not.toBeCallableWith(Schema.optionalKey(Schema.String))
    })

    it("should be callable with a schema with Schema.optional", () => {
      const schema = Schema.required(Schema.optional(Schema.String))
      expect(schema).type.toBe<Schema.String>()
    })

    it("top level call", () => {
      {
        const schema = Schema.required(Schema.optional(Schema.String))
        expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<string, string, never>>()
        expect(schema).type.toBe<Schema.String>()
      }

      {
        const schema = Schema.optional(Schema.String).pipe(Schema.required)
        expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<string, string, never>>()
        expect(schema).type.toBe<Schema.String>()
      }
    })

    it("mapFields should throw an error if there is a field with no Schema.optional", () => {
      expect(
        Schema.Struct({
          a: Schema.String
        }).mapFields
      ).type.not.toBeCallableWith(Struct.map(Schema.required))
    })
  })

  describe("Class", () => {
    it("Fields argument", () => {
      class A extends Schema.Class<A>("A")({
        a: Schema.String
      }) {}

      expect(new A({ a: "a" })).type.toBe<A>()
      expect(A.makeUnsafe({ a: "a" })).type.toBe<A>()
      expect(Schema.revealCodec(A)).type.toBe<Schema.Codec<A, { readonly a: string }>>()
      expect(revealClass(A)).type.toBe<
        Schema.Class<A, Schema.Struct<{ readonly a: Schema.String }>, A>
      >()
      expect(A.fields).type.toBe<{ readonly a: Schema.String }>()
      expect(A.annotate({})).type.toBe<
        Schema.decodeTo<
          Schema.declareConstructor<
            A,
            { readonly a: string },
            readonly [Schema.Struct<{ readonly a: Schema.String }>],
            { readonly a: string }
          >,
          Schema.Struct<{ readonly a: Schema.String }>
        >
      >()
    })

    it("Struct argument", () => {
      class A extends Schema.Class<A>("A")(Schema.Struct({
        a: Schema.String
      })) {}

      expect(new A({ a: "a" })).type.toBe<A>()
      expect(A.makeUnsafe({ a: "a" })).type.toBe<A>()
      expect(Schema.revealCodec(A)).type.toBe<Schema.Codec<A, { readonly a: string }>>()
      expect(revealClass(A)).type.toBe<
        Schema.Class<A, Schema.Struct<{ readonly a: Schema.String }>, A>
      >()
      expect(A.fields).type.toBe<{ readonly a: Schema.String }>()
    })

    it("mapFields", () => {
      class A extends Schema.Class<A>("A")({
        a: Schema.String
      }) {}
      const schema = A.mapFields((fields) => ({ ...fields, b: Schema.Number }))
      expect(schema).type.toBe<Schema.Struct<{ readonly a: Schema.String; readonly b: Schema.Number }>>()
    })

    it("should reject non existing props", () => {
      class A extends Schema.Class<A>("A")({
        a: Schema.String
      }) {}

      expect(A).type.not.toBeConstructableWith({ a: "a", b: "b" })
      expect(A.makeUnsafe).type.not.toBeCallableWith({ a: "a", b: "b" })
    })

    it("should be compatible with `immer`", () => {
      class A extends Schema.Class<A>("A")({
        a: Schema.Struct({ b: Schema.FiniteFromString }).pipe(Schema.optional)
      }) {
        [immerable] = true
      }

      const a = new A({ a: { b: 1 } })

      const modified = produce(a, (draft) => {
        if (draft.a) {
          draft.a.b = 2
        }
      })

      expect(modified).type.toBe<A>()
    })

    it("mutable field", () => {
      class A extends Schema.Class<A>("A")({
        a: Schema.String.pipe(Schema.mutableKey)
      }) {}

      expect(Schema.revealCodec(A)).type.toBe<Schema.Codec<A, { a: string }>>()
    })

    it("branded (unique symbol)", () => {
      class A extends Schema.Class<A>("A")({
        a: Schema.String
      }) {}
      class B extends Schema.Class<B>("B")({
        a: Schema.String
      }) {}

      const f = (a: A) => a

      f(A.makeUnsafe({ a: "a" }))
      f(B.makeUnsafe({ a: "a" }))

      class ABranded extends Schema.Class<ABranded, { readonly brand: unique symbol }>("ABranded")({
        a: Schema.String
      }) {}
      class BBranded extends Schema.Class<BBranded, { readonly brand: unique symbol }>("BBranded")({
        a: Schema.String
      }) {}

      const fABranded = (a: ABranded) => a

      fABranded(ABranded.makeUnsafe({ a: "a" }))
      when(fABranded).isCalledWith(expect(BBranded.makeUnsafe).type.not.toBeCallableWith({ a: "a" }))

      const fBBranded = (a: BBranded) => a

      fBBranded(BBranded.makeUnsafe({ a: "a" }))
      when(fBBranded).isCalledWith(expect(ABranded.makeUnsafe).type.not.toBeCallableWith({ a: "a" }))
    })

    it("branded (Brand module)", () => {
      class ABranded extends Schema.Class<ABranded, Brand.Brand<"A">>("ABranded")({
        a: Schema.String
      }) {}
      class BBranded extends Schema.Class<BBranded, Brand.Brand<"B">>("BBranded")({
        a: Schema.String
      }) {}

      const fABranded = (a: ABranded) => a

      fABranded(ABranded.makeUnsafe({ a: "a" }))
      when(fABranded).isCalledWith(expect(BBranded.makeUnsafe).type.not.toBeCallableWith({ a: "a" }))

      const fBBranded = (a: BBranded) => a

      fBBranded(BBranded.makeUnsafe({ a: "a" }))
      when(fBBranded).isCalledWith(expect(ABranded.makeUnsafe).type.not.toBeCallableWith({ a: "a" }))
    })

    it("extend & branded (unique symbol)", () => {
      class Common extends Schema.Class<Common>("Common")({
        a: Schema.String
      }) {}
      class E1 extends Common.extend<E1, {}, { readonly brand: unique symbol }>("E1")({
        b: Schema.String
      }) {}
      class E2 extends Common.extend<E2, {}, { readonly brand: unique symbol }>("E2")({
        b: Schema.String
      }) {}

      const f1 = (e1: E1) => e1

      f1(E1.makeUnsafe({ a: "a", b: "b" }))
      when(f1).isCalledWith(expect(E2.makeUnsafe).type.not.toBeCallableWith({ a: "a", b: "b" }))

      const f2 = (e2: E2) => e2

      f2(E2.makeUnsafe({ a: "a", b: "b" }))
      when(f2).isCalledWith(expect(E1.makeUnsafe).type.not.toBeCallableWith({ a: "a", b: "b" }))
    })
  })

  describe("TaggedClass", () => {
    it("Fields argument", () => {
      class A extends Schema.TaggedClass<A>()("A", {
        a: Schema.String
      }) {}

      expect(Schema.revealCodec(A)).type.toBe<Schema.Codec<A, { readonly _tag: "A"; readonly a: string }>>()
      expect(revealClass(A)).type.toBe<
        Schema.Class<A, Schema.TaggedStruct<"A", { readonly a: Schema.String }>, A>
      >()
      expect(A.fields).type.toBe<{ readonly _tag: Schema.tag<"A">; readonly a: Schema.String }>()
    })

    it("Struct argument", () => {
      class A extends Schema.TaggedClass<A>()(
        "A",
        Schema.Struct({
          a: Schema.String
        })
      ) {}

      expect(Schema.revealCodec(A)).type.toBe<Schema.Codec<A, { readonly _tag: "A"; readonly a: string }>>()
      expect(revealClass(A)).type.toBe<
        Schema.Class<A, Schema.Struct<{ readonly _tag: Schema.tag<"A">; readonly a: Schema.String }>, A>
      >()
      expect(A.fields).type.toBe<{ readonly _tag: Schema.tag<"A">; readonly a: Schema.String }>()
    })
  })

  describe("Error", () => {
    it("extend Fields", () => {
      class E extends Schema.ErrorClass<E>("E")({
        a: Schema.String
      }) {}

      expect(new E({ a: "a" })).type.toBe<E>()
      expect(E.makeUnsafe({ a: "a" })).type.toBe<E>()
      expect(Schema.revealCodec(E)).type.toBe<Schema.Codec<E, { readonly a: string }>>()

      expect(Effect.gen(function*() {
        return yield* new E({ a: "a" })
      })).type.toBe<Effect.Effect<never, E>>()
    })

    it("extend Struct", () => {
      class E extends Schema.ErrorClass<E>("E")(Schema.Struct({
        a: Schema.String
      })) {}

      expect(new E({ a: "a" })).type.toBe<E>()
      expect(E.makeUnsafe({ a: "a" })).type.toBe<E>()
      expect(Schema.revealCodec(E)).type.toBe<Schema.Codec<E, { readonly a: string }>>()

      expect(Effect.gen(function*() {
        return yield* new E({ a: "a" })
      })).type.toBe<Effect.Effect<never, E>>()
    })

    it("should reject non existing props", () => {
      class E extends Schema.ErrorClass<E>("E")({
        a: Schema.String
      }) {}

      expect(E).type.not.toBeConstructableWith({ a: "a", b: "b" })
      expect(E.makeUnsafe).type.not.toBeCallableWith({ a: "a", b: "b" })
    })

    it("mutable field", () => {
      class E extends Schema.ErrorClass<E>("E")({
        a: Schema.String.pipe(Schema.mutableKey)
      }) {}

      expect(Schema.revealCodec(E)).type.toBe<Schema.Codec<E, { a: string }>>()
    })
  })

  describe("brand", () => {
    it("brand", () => {
      const schema = Schema.Number.pipe(Schema.brand("MyBrand"))
      expect(Schema.revealCodec(schema)).type.toBe<
        Schema.Codec<number & Brand.Brand<"MyBrand">, number, never, never>
      >()
      expect(schema).type.toBe<Schema.brand<Schema.Number, "MyBrand">>()
      expect(schema.annotate({})).type.toBe<Schema.brand<Schema.Number, "MyBrand">>()
    })

    it("double brand", () => {
      const schema = Schema.Number.pipe(Schema.brand("MyBrand"), Schema.brand("MyBrand2"))
      expect(Schema.revealCodec(schema)).type.toBe<
        Schema.Codec<number & Brand.Brand<"MyBrand"> & Brand.Brand<"MyBrand2">, number, never, never>
      >()
      expect(schema).type.toBe<
        Schema.brand<Schema.brand<Schema.Number, "MyBrand">, "MyBrand2">
      >()
      expect(schema.annotate({})).type.toBe<
        Schema.brand<Schema.brand<Schema.Number, "MyBrand">, "MyBrand2">
      >()
    })
  })

  it("decodeTo as composition", () => {
    const From = Schema.Struct({
      a: Schema.String,
      b: Schema.FiniteFromString
    })

    const To = Schema.Struct({
      a: Schema.FiniteFromString,
      b: Schema.UndefinedOr(Schema.Number)
    })

    const schema = From.pipe(Schema.decodeTo(To))

    expect(Schema.revealCodec(schema)).type.toBe<
      Schema.Codec<
        { readonly a: number; readonly b: number | undefined },
        { readonly a: string; readonly b: string },
        never,
        never
      >
    >()
    expect(schema).type.toBe<
      Schema.compose<
        Schema.Struct<
          { readonly a: Schema.FiniteFromString; readonly b: Schema.Union<readonly [Schema.Number, Schema.Undefined]> }
        >,
        Schema.Struct<{ readonly a: Schema.String; readonly b: Schema.FiniteFromString }>
      >
    >()
    expect(schema.annotate({})).type.toBe<
      Schema.compose<
        Schema.Struct<
          { readonly a: Schema.FiniteFromString; readonly b: Schema.Union<readonly [Schema.Number, Schema.Undefined]> }
        >,
        Schema.Struct<{ readonly a: Schema.String; readonly b: Schema.FiniteFromString }>
      >
    >()
  })

  it("encodeTo as composition", () => {
    const From = Schema.Struct({
      a: Schema.String,
      b: Schema.FiniteFromString
    })

    const To = Schema.Struct({
      a: Schema.FiniteFromString,
      b: Schema.UndefinedOr(Schema.Number)
    })

    const schema = To.pipe(Schema.encodeTo(From))

    expect(Schema.revealCodec(schema)).type.toBe<
      Schema.Codec<
        { readonly a: number; readonly b: number | undefined },
        { readonly a: string; readonly b: string },
        never,
        never
      >
    >()
    expect(schema).type.toBe<
      Schema.compose<
        Schema.Struct<
          { readonly a: Schema.FiniteFromString; readonly b: Schema.Union<readonly [Schema.Number, Schema.Undefined]> }
        >,
        Schema.Struct<{ readonly a: Schema.String; readonly b: Schema.FiniteFromString }>
      >
    >()
    expect(schema.annotate({})).type.toBe<
      Schema.compose<
        Schema.Struct<
          { readonly a: Schema.FiniteFromString; readonly b: Schema.Union<readonly [Schema.Number, Schema.Undefined]> }
        >,
        Schema.Struct<{ readonly a: Schema.String; readonly b: Schema.FiniteFromString }>
      >
    >()
  })

  describe("withConstructorDefault", () => {
    it("should be possible to access the original schema", () => {
      const schema = Schema.Struct({
        a: Schema.String.pipe(Schema.withConstructorDefault(() => Option.some("a")))
      })

      expect(schema.fields.a.schema).type.toBe<Schema.String>()
    })

    it("effectful", () => {
      const service = hole<ServiceMap.Service<"Tag", "-">>()

      const schema = Schema.String.pipe(Schema.withConstructorDefault(() =>
        Effect.gen(function*() {
          yield* Effect.serviceOption(service)
          return Option.some("some-result")
        })
      ))

      expect(schema.makeUnsafe).type.toBe<(input: string, options?: Schema.MakeOptions | undefined) => string>()

      expect(Schema.revealCodec(schema)).type.toBe<Schema.Codec<string, string, never, never>>()
    })
  })

  it("encodeKeys", () => {
    const schema = Schema.Struct({
      a: Schema.FiniteFromString,
      b: Schema.String
    }).pipe(Schema.encodeKeys({ a: "c" }))

    expect(schema).type.toBe<
      Schema.decodeTo<
        Schema.Struct<{
          readonly a: Schema.FiniteFromString
          readonly b: Schema.String
        }>,
        Schema.Struct<{
          readonly c: Schema.toEncoded<Schema.FiniteFromString>
          readonly b: Schema.toEncoded<Schema.String>
        }>
      >
    >()
  })

  it("tag", () => {
    const schema = Schema.tag("A")
    expect(schema).type.toBe<Schema.tag<"A">>()
    expect(schema.schema).type.toBe<Schema.Literal<"A">>()
    expect(schema.schema.literal).type.toBe<"A">()
  })

  it("withDecodingDefaultKey", () => {
    const schema = Schema.Struct({
      a: Schema.FiniteFromString.pipe(Schema.withDecodingDefaultKey(() => "1"))
    })

    expect(schema).type.toBe<Schema.Struct<{ readonly a: Schema.withDecodingDefaultKey<Schema.FiniteFromString> }>>()
    expect(Schema.revealCodec(schema)).type.toBe<
      Schema.Codec<{ readonly a: number }, { readonly a?: string }, never, never>
    >()
  })

  it("withDecodingDefault", () => {
    const schema = Schema.Struct({
      a: Schema.FiniteFromString.pipe(Schema.withDecodingDefault(() => "1"))
    })

    expect(schema).type.toBe<Schema.Struct<{ readonly a: Schema.withDecodingDefault<Schema.FiniteFromString> }>>()
    expect(Schema.revealCodec(schema)).type.toBe<
      Schema.Codec<{ readonly a: number }, { readonly a?: string | undefined }, never, never>
    >()
  })

  it("asStandardSchemaV1 should not be callable with a schema with DecodingServices", () => {
    class MagicNumber extends ServiceMap.Service<MagicNumber, number>()("MagicNumber") {}
    const DepString = Schema.Number.pipe(Schema.decode({
      decode: SchemaGetter.onSome((n) =>
        Effect.gen(function*() {
          const magicNumber = yield* MagicNumber
          return Option.some(n * magicNumber)
        })
      ),
      encode: SchemaGetter.passthrough()
    }))
    expect(Schema.toStandardSchemaV1).type.not.toBeCallableWith(DepString)
  })

  describe("fromBrand", () => {
    it("should not be callable with a schema with wrong type", () => {
      type Int = number & Brand.Brand<"Int">
      const Int = Brand.check<Int>(Schema.isInt())
      when(Schema.String.pipe).isCalledWith(expect(Schema.fromBrand).type.not.toBeCallableWith("Int", Int))
    })

    it("single brand", () => {
      type Int = number & Brand.Brand<"Int">
      const Int = Brand.check<Int>(Schema.isInt())
      const schema = Schema.Number.pipe(Schema.fromBrand("Int", Int))
      expect(schema).type.toBe<Schema.brand<Schema.Number, "Int">>()
    })

    it("should convert a union of keys to an intersection of brands", () => {
      type Int = number & Brand.Brand<"Int">
      const Int = Brand.check<Int>(Schema.isInt())

      type Positive = number & Brand.Brand<"Positive">
      const Positive = Brand.check<Positive>(Schema.isGreaterThan(0))

      const PositiveInt = Brand.all(Int, Positive)

      const schema = Schema.Number.pipe(Schema.fromBrand("PositiveInt", PositiveInt))
      expect(schema).type.toBe<Schema.brand<Schema.Number, "Int" | "Positive">>()
      expect(Schema.revealCodec(schema)).type.toBe<
        Schema.Codec<number & Brand.Brand<"Int"> & Brand.Brand<"Positive">, number>
      >()
    })
  })

  describe("fieldsAssign", () => {
    it("Struct", () => {
      const schema = Schema.Union([
        Schema.Struct({
          a: Schema.String
        }),
        Schema.Struct({
          b: Schema.Number
        })
      ]).mapMembers(Tuple.map(Schema.fieldsAssign({ c: Schema.Number })))

      expect(schema).type.toBe<
        Schema.Union<
          readonly [
            Schema.Struct<{
              readonly a: Schema.String
              readonly c: Schema.Number
            }>,
            Schema.Struct<{
              readonly b: Schema.Number
              readonly c: Schema.Number
            }>
          ]
        >
      >()
    })

    it("should throw an error if there is a field that is not a struct", () => {
      expect(
        Schema.Union([
          Schema.String,
          Schema.Number
        ]).mapMembers
      ).type.not.toBeCallableWith(Tuple.map(Schema.fieldsAssign({ c: Schema.Number })))
    })
  })
})
