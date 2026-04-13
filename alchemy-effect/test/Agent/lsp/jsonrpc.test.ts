import {
  encodeMessage,
  parseBuffer,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "@/Agent/lsp/jsonrpc";
import { describe, expect, it } from "@effect/vitest";

const encoder = new TextEncoder();

/**
 * Helper to create a wire-format message as bytes.
 */
const toWireFormat = (msg: object): Uint8Array => {
  const json = JSON.stringify(msg);
  const body = encoder.encode(json);
  const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const result = new Uint8Array(header.length + body.length);
  result.set(header);
  result.set(body, header.length);
  return result;
};

/**
 * Concatenate multiple Uint8Arrays.
 */
const concat = (...arrays: Uint8Array[]): Uint8Array => {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
};

describe("jsonrpc", () => {
  describe("encodeMessage", () => {
    it("encodes a request with Content-Length header", () => {
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { rootUri: "file:///test" },
      };

      const encoded = encodeMessage(request);
      const decoded = new TextDecoder().decode(encoded);

      const json = JSON.stringify(request);
      const expected = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
      expect(decoded).toBe(expected);
    });

    it("encodes a notification without id", () => {
      const notification: JsonRpcNotification = {
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri: "file:///test.ts" } },
      };

      const encoded = encodeMessage(notification);
      const decoded = new TextDecoder().decode(encoded);

      const json = JSON.stringify(notification);
      const expected = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
      expect(decoded).toBe(expected);
    });

    it("encodes a response with result", () => {
      const response: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: 42,
        result: { capabilities: { textDocumentSync: 1 } },
      };

      const encoded = encodeMessage(response);
      const decoded = new TextDecoder().decode(encoded);

      const json = JSON.stringify(response);
      const expected = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
      expect(decoded).toBe(expected);
    });

    it("encodes a response with error", () => {
      const response: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32600,
          message: "Invalid Request",
        },
      };

      const encoded = encodeMessage(response);
      const decoded = new TextDecoder().decode(encoded);

      const json = JSON.stringify(response);
      const expected = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
      expect(decoded).toBe(expected);
    });

    it("correctly calculates byte length for unicode", () => {
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "test",
        params: { text: "こんにちは世界" }, // Japanese: "Hello World"
      };

      const encoded = encodeMessage(request);
      const decoded = new TextDecoder().decode(encoded);

      // Extract Content-Length
      const match = /Content-Length: (\d+)/.exec(decoded);
      expect(match).toBeTruthy();
      const contentLength = parseInt(match![1], 10);

      // Extract body
      const bodyStart = decoded.indexOf("\r\n\r\n") + 4;
      const body = decoded.slice(bodyStart);
      const bodyBytes = new TextEncoder().encode(body);

      expect(bodyBytes.length).toBe(contentLength);
    });
  });

  describe("parseBuffer", () => {
    it("parses a single complete message", () => {
      const msg: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "test",
      };
      const buffer = toWireFormat(msg);

      const result = parseBuffer(buffer);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual(msg);
      expect(result.remaining.length).toBe(0);
    });

    it("parses multiple complete messages", () => {
      const msg1: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method: "first" };
      const msg2: JsonRpcRequest = { jsonrpc: "2.0", id: 2, method: "second" };

      const buffer = concat(toWireFormat(msg1), toWireFormat(msg2));

      const result = parseBuffer(buffer);

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]).toEqual(msg1);
      expect(result.messages[1]).toEqual(msg2);
      expect(result.remaining.length).toBe(0);
    });

    it("returns remaining buffer for incomplete message", () => {
      const msg: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method: "test" };
      const full = toWireFormat(msg);
      // Incomplete: missing last 5 bytes
      const buffer = full.slice(0, full.length - 5);

      const result = parseBuffer(buffer);

      expect(result.messages).toHaveLength(0);
      expect(result.remaining.length).toBe(buffer.length);
    });

    it("returns remaining buffer for incomplete header", () => {
      const buffer = encoder.encode("Content-Length: 50\r\n");

      const result = parseBuffer(buffer);

      expect(result.messages).toHaveLength(0);
      expect(result.remaining.length).toBe(buffer.length);
    });

    it("handles empty buffer", () => {
      const result = parseBuffer(new Uint8Array(0));

      expect(result.messages).toHaveLength(0);
      expect(result.remaining.length).toBe(0);
    });

    it("parses complete message and keeps partial message as remaining", () => {
      const msg1: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "complete",
      };
      const partial = encoder.encode("Content-Length: 100\r\n\r\n{");

      const buffer = concat(toWireFormat(msg1), partial);

      const result = parseBuffer(buffer);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual(msg1);
      expect(result.remaining.length).toBe(partial.length);
    });

    it("handles case-insensitive Content-Length header", () => {
      const msg: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method: "test" };
      const json = JSON.stringify(msg);
      const body = encoder.encode(json);
      const header = encoder.encode(`content-length: ${body.length}\r\n\r\n`);
      const buffer = concat(header, body);

      const result = parseBuffer(buffer);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual(msg);
    });

    it("handles Content-Length with extra whitespace", () => {
      const msg: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method: "test" };
      const json = JSON.stringify(msg);
      const body = encoder.encode(json);
      const header = encoder.encode(`Content-Length:   ${body.length}\r\n\r\n`);
      const buffer = concat(header, body);

      const result = parseBuffer(buffer);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual(msg);
    });

    it("skips invalid JSON and continues", () => {
      const invalid = "not valid json";
      const msg: JsonRpcRequest = { jsonrpc: "2.0", id: 2, method: "valid" };

      const invalidBody = encoder.encode(invalid);
      const invalidHeader = encoder.encode(
        `Content-Length: ${invalidBody.length}\r\n\r\n`,
      );
      const invalidMessage = concat(invalidHeader, invalidBody);

      const buffer = concat(invalidMessage, toWireFormat(msg));

      const result = parseBuffer(buffer);

      // Invalid JSON is skipped, valid message is parsed
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual(msg);
      expect(result.remaining.length).toBe(0);
    });

    it("handles notification messages", () => {
      const notification: JsonRpcNotification = {
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri: "file:///test.ts", diagnostics: [] },
      };
      const buffer = toWireFormat(notification);

      const result = parseBuffer(buffer);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual(notification);
      expect("id" in result.messages[0]).toBe(false);
    });

    it("handles response with error", () => {
      const response: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "Method not found" },
      };
      const buffer = toWireFormat(response);

      const result = parseBuffer(buffer);

      expect(result.messages).toHaveLength(1);
      const parsed = result.messages[0] as JsonRpcResponse;
      expect(parsed.error).toBeDefined();
      expect(parsed.error?.code).toBe(-32601);
      expect(parsed.error?.message).toBe("Method not found");
    });

    it("handles additional headers before Content-Length", () => {
      const msg: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method: "test" };
      const json = JSON.stringify(msg);
      const body = encoder.encode(json);
      // Some LSP implementations send Content-Type header too
      const header = encoder.encode(
        `Content-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`,
      );
      const buffer = concat(header, body);

      const result = parseBuffer(buffer);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual(msg);
    });

    it("correctly handles unicode content", () => {
      const msg: JsonRpcNotification = {
        jsonrpc: "2.0",
        method: "test",
        params: { text: "こんにちは世界" }, // Japanese: "Hello World"
      };
      const buffer = toWireFormat(msg);

      const result = parseBuffer(buffer);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual(msg);
      expect(result.remaining.length).toBe(0);
    });
  });

  describe("roundtrip", () => {
    it("encode then parse produces original message", () => {
      const original: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 123,
        method: "textDocument/completion",
        params: {
          textDocument: { uri: "file:///src/main.ts" },
          position: { line: 10, character: 5 },
        },
      };

      const encoded = encodeMessage(original);
      const result = parseBuffer(encoded);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual(original);
      expect(result.remaining.length).toBe(0);
    });

    it("handles unicode in roundtrip", () => {
      const original: JsonRpcNotification = {
        jsonrpc: "2.0",
        method: "window/logMessage",
        params: { message: "Файл сохранён успешно 🎉" }, // Russian + emoji
      };

      const encoded = encodeMessage(original);
      const result = parseBuffer(encoded);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual(original);
      expect(result.remaining.length).toBe(0);
    });

    it("handles Japanese unicode in roundtrip", () => {
      const original: JsonRpcNotification = {
        jsonrpc: "2.0",
        method: "test",
        params: { text: "こんにちは世界" },
      };

      const encoded = encodeMessage(original);
      const result = parseBuffer(encoded);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual(original);
      expect(result.remaining.length).toBe(0);
    });

    it("handles multiple messages in sequence", () => {
      const msg1: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method: "first" };
      const msg2: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: 1,
        result: { ok: true },
      };
      const msg3: JsonRpcNotification = { jsonrpc: "2.0", method: "notify" };

      const encoded = concat(
        encodeMessage(msg1),
        encodeMessage(msg2),
        encodeMessage(msg3),
      );
      const result = parseBuffer(encoded);

      expect(result.messages).toHaveLength(3);
      expect(result.messages[0]).toEqual(msg1);
      expect(result.messages[1]).toEqual(msg2);
      expect(result.messages[2]).toEqual(msg3);
      expect(result.remaining.length).toBe(0);
    });
  });
});
