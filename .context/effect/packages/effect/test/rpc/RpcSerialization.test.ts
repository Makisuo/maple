import { assert, describe, it } from "@effect/vitest"
import { RpcSerialization } from "effect/unstable/rpc"

const responseExitSuccess = (requestId: string, value: unknown) => ({
  _tag: "Exit",
  requestId,
  exit: {
    _tag: "Success",
    value
  }
})

describe("RpcSerialization", () => {
  it("json decode keeps array payloads flat", () => {
    const parser = RpcSerialization.json.makeUnsafe()
    const decoded = parser.decode("[1,2,3]")
    assert.strictEqual(decoded.length, 3)
    assert.deepStrictEqual(decoded, [1, 2, 3])
  })

  it("json decode wraps non-array payloads", () => {
    const parser = RpcSerialization.json.makeUnsafe()
    const decoded = parser.decode("{\"a\":1}")
    assert.strictEqual(decoded.length, 1)
    assert.deepStrictEqual(decoded, [{ a: 1 }])
  })

  it("jsonRpc encodes a non-batched single response array as an object", () => {
    const parser = RpcSerialization.jsonRpc().makeUnsafe()
    const decoded = parser.decode("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"users.get\"}")
    assert.strictEqual(decoded.length, 1)

    const encoded = parser.encode([responseExitSuccess("1", { id: 1 })])
    assert(encoded !== undefined)

    const message = JSON.parse(encoded as string)
    assert.strictEqual(Array.isArray(message), false)
    assert.deepStrictEqual(message, {
      jsonrpc: "2.0",
      id: 1,
      result: {
        id: 1
      }
    })
  })

  it("jsonRpc encodes batched responses as an array", () => {
    const parser = RpcSerialization.jsonRpc().makeUnsafe()
    const decoded = parser.decode(
      "[{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"users.get\"},{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"users.list\"}]"
    )
    assert.strictEqual(decoded.length, 2)

    const encoded = parser.encode([
      responseExitSuccess("1", "one"),
      responseExitSuccess("2", "two")
    ])
    assert(encoded !== undefined)

    const message = JSON.parse(encoded as string)
    assert.strictEqual(Array.isArray(message), true)
    assert.deepStrictEqual(message, [
      {
        jsonrpc: "2.0",
        id: 1,
        result: "one"
      },
      {
        jsonrpc: "2.0",
        id: 2,
        result: "two"
      }
    ])
  })
})
