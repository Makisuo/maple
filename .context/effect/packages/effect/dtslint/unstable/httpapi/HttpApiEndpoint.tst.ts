import { Schema, Struct } from "effect"
import { HttpApiEndpoint, type HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { describe, expect, it } from "tstyche"

describe("HttpApiEndpoint", () => {
  describe("params option", () => {
    it("should default to never", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a")
      type T = typeof endpoint["~Params"]
      expect<T>().type.toBe<HttpApiEndpoint.StringTree<never>>()
    })

    it("should accept a record of fields", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        params: {
          id: Schema.Finite
        }
      })
      type T = typeof endpoint["~Params"]
      expect<T>().type.toBe<
        HttpApiEndpoint.StringTree<
          Schema.Struct<{ id: Schema.Finite }>
        >
      >()
    })

    it("should accept a Struct", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        params: Schema.Struct({ a: Schema.Finite, b: Schema.Finite })
      })
      type T = typeof endpoint["~Params"]
      expect<T>().type.toBe<
        HttpApiEndpoint.StringTree<
          Schema.Struct<{ readonly a: Schema.Finite; readonly b: Schema.Finite }>
        >
      >()
    })
  })

  describe("query option", () => {
    it("should default to never", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a")
      type T = typeof endpoint["~Query"]
      expect<T>().type.toBe<HttpApiEndpoint.StringTree<never>>()
    })

    it("should accept a record of fields", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        query: {
          id: Schema.Finite
        }
      })
      type T = typeof endpoint["~Query"]
      expect<T>().type.toBe<HttpApiEndpoint.StringTree<Schema.Struct<{ id: Schema.Finite }>>>()
    })

    it("should accept a Struct.Record", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        query: Struct.Record(["a", "b"], Schema.Finite)
      })
      type T = typeof endpoint["~Query"]
      expect<T>().type.toBe<HttpApiEndpoint.StringTree<Schema.Struct<Record<"a" | "b", Schema.Finite>>>>()
      expect<T>().type.toBe<HttpApiEndpoint.StringTree<Schema.Struct<{ a: Schema.Finite; b: Schema.Finite }>>>()
    })

    it("should accept a Struct", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        query: Schema.Struct({ a: Schema.Finite, b: Schema.Finite })
      })
      type T = typeof endpoint["~Query"]
      expect<T>().type.toBe<
        HttpApiEndpoint.StringTree<
          Schema.Struct<{ readonly a: Schema.Finite; readonly b: Schema.Finite }>
        >
      >()
    })
  })

  describe("headers option", () => {
    it("should default to never", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a")
      type T = typeof endpoint["~Headers"]
      expect<T>().type.toBe<HttpApiEndpoint.StringTree<never>>()
    })

    it("should accept a record of fields", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        headers: {
          id: Schema.FiniteFromString
        }
      })
      type T = typeof endpoint["~Headers"]
      expect<T>().type.toBe<HttpApiEndpoint.StringTree<Schema.Struct<{ id: Schema.FiniteFromString }>>>()
    })

    it("should accept a Struct", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        headers: Schema.Struct({ a: Schema.FiniteFromString, b: Schema.FiniteFromString })
      })
      type T = typeof endpoint["~Headers"]
      expect<T>().type.toBe<
        HttpApiEndpoint.StringTree<
          Schema.Struct<{ readonly a: Schema.FiniteFromString; readonly b: Schema.FiniteFromString }>
        >
      >()
    })
  })

  describe("payload option", () => {
    it("should default to never", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a")
      type T = typeof endpoint["~Payload"]
      expect<T>().type.toBe<HttpApiEndpoint.StringTree<never>>()
    })

    describe("GET", () => {
      it("should accept a record of fields", () => {
        const endpoint = HttpApiEndpoint.get("a", "/a", {
          payload: {
            id: Schema.Finite
          }
        })
        type T = typeof endpoint["~Payload"]
        expect<T>().type.toBe<HttpApiEndpoint.StringTree<Schema.Struct<{ id: Schema.Finite }>>>()
      })

      it("should not accept any other schema", () => {
        HttpApiEndpoint.get("a", "/a", {
          // @ts-expect-error Type 'Struct<{ readonly id: String; }>' is not assignable to type 'Record<string, Encoder<string | readonly string[] | undefined, unknown>>'.
          payload: Schema.Struct({ id: Schema.String })
        })
      })
    })

    describe("POST", () => {
      it("should accept a schema", () => {
        const endpoint = HttpApiEndpoint.post("a", "/a", {
          payload: Schema.Struct({ a: Schema.String })
        })
        type T = typeof endpoint["~Payload"]
        expect<T>().type.toBe<HttpApiEndpoint.Json<Schema.Struct<{ readonly a: Schema.String }>>>()
      })

      it("should accept an array of schemas", () => {
        const endpoint = HttpApiEndpoint.post("a", "/a", {
          payload: [
            Schema.Struct({ a: Schema.String }), // application/json
            Schema.String.pipe(HttpApiSchema.asText()), // text/plain
            Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()) // application/octet-stream
          ]
        })
        type T = typeof endpoint["~Payload"]
        expect<T>().type.toBe<
          HttpApiEndpoint.Json<
            Schema.String | Schema.Struct<{ readonly a: Schema.String }> | Schema.Uint8Array
          >
        >()
      })
    })

    describe("HEAD", () => {
      it("should accept a record of fields", () => {
        const endpoint = HttpApiEndpoint.head("a", "/a", {
          payload: {
            id: Schema.Finite
          }
        })
        type T = typeof endpoint["~Payload"]
        expect<T>().type.toBe<HttpApiEndpoint.StringTree<Schema.Struct<{ id: Schema.Finite }>>>()
      })

      it("should not accept any other schema", () => {
        HttpApiEndpoint.head("a", "/a", {
          // @ts-expect-error Type 'Struct<{ readonly id: String; }>' is not assignable to type 'Record<string, Encoder<string | readonly string[] | undefined, unknown>>'.
          payload: Schema.Struct({ id: Schema.String })
        })
      })
    })

    describe("OPTIONS", () => {
      it("should accept a record of fields", () => {
        const endpoint = HttpApiEndpoint.options("a", "/a", {
          payload: {
            id: Schema.Finite
          }
        })
        type T = typeof endpoint["~Payload"]
        expect<T>().type.toBe<HttpApiEndpoint.StringTree<Schema.Struct<{ id: Schema.Finite }>>>()
      })

      it("should not accept any other schema", () => {
        HttpApiEndpoint.options("a", "/a", {
          // @ts-expect-error Type 'Struct<{ readonly id: String; }>' is not assignable to type 'Record<string, Encoder<string | readonly string[] | undefined, unknown>>'.
          payload: Schema.Struct({ id: Schema.String })
        })
      })
    })
  })

  describe("success option", () => {
    it("should default to HttpApiSchema.NoContent", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a")
      type T = typeof endpoint["~Success"]
      expect<T>().type.toBe<HttpApiEndpoint.Json<typeof HttpApiSchema.NoContent>>()
    })

    it("should accept a schema", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: Schema.Struct({ a: Schema.String })
      })
      type T = typeof endpoint["~Success"]
      expect<T>().type.toBe<HttpApiEndpoint.Json<Schema.Struct<{ readonly a: Schema.String }>>>()
    })

    it("should accept an array of schemas", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: [
          Schema.Struct({ a: Schema.String }), // application/json
          Schema.String.pipe(HttpApiSchema.asText()), // text/plain
          Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()) // application/octet-stream
        ]
      })
      type T = typeof endpoint["~Success"]
      expect<T>().type.toBe<
        HttpApiEndpoint.Json<Schema.String | Schema.Struct<{ readonly a: Schema.String }> | Schema.Uint8Array>
      >()
    })
  })

  describe("error option", () => {
    it("should default to BadRequestNoContent", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a")
      type T = typeof endpoint["~Error"]
      expect<T>().type.toBe<HttpApiEndpoint.Json<typeof HttpApiError.BadRequestNoContent>>()
    })

    it("should accept a schema", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        error: Schema.Struct({ a: Schema.String })
      })
      type T = typeof endpoint["~Error"]
      expect<T>().type.toBe<
        HttpApiEndpoint.Json<
          | Schema.Struct<{ readonly a: Schema.String }>
          | typeof HttpApiError.BadRequestNoContent
        >
      >()
    })

    it("should accept an array of schemas", () => {
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        error: [
          Schema.Struct({ a: Schema.String }), // application/json
          Schema.String.pipe(HttpApiSchema.asText()), // text/plain
          Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()) // application/octet-stream
        ]
      })
      type T = typeof endpoint["~Error"]
      expect<T>().type.toBe<
        HttpApiEndpoint.Json<
          | Schema.String
          | Schema.Struct<{ readonly a: Schema.String }>
          | Schema.Uint8Array
          | typeof HttpApiError.BadRequestNoContent
        >
      >()
    })
  })
})
