import type { Subprocess } from "bun";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

/**
 * JSON-RPC 2.0 message types
 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

/**
 * Error from JSON-RPC protocol.
 */
export class JsonRpcProtocolError extends Data.TaggedError(
  "JsonRpcProtocolError",
)<{
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}> {}

/**
 * Error parsing JSON-RPC messages from stream.
 */
export class JsonRpcParseError extends Data.TaggedError("JsonRpcParseError")<{
  readonly cause: unknown;
}> {}

/**
 * Encode a JSON-RPC message with LSP wire format headers.
 * Format: Content-Length: <length>\r\n\r\n<json>
 */
export const encodeMessage = (msg: JsonRpcMessage): Uint8Array => {
  const json = JSON.stringify(msg);
  const body = new TextEncoder().encode(json);
  const header = `Content-Length: ${body.byteLength}\r\n\r\n`;
  const headerBytes = new TextEncoder().encode(header);

  const result = new Uint8Array(headerBytes.length + body.length);
  result.set(headerBytes);
  result.set(body, headerBytes.length);
  return result;
};

/**
 * Parse LSP messages from a byte buffer.
 * Returns parsed messages and remaining buffer.
 * Works with bytes to correctly handle Content-Length (which is in bytes, not characters).
 */
export const parseBuffer = (
  buffer: Uint8Array,
): { messages: JsonRpcMessage[]; remaining: Uint8Array<ArrayBuffer> } => {
  const messages: JsonRpcMessage[] = [];
  let offset = 0;
  const decoder = new TextDecoder();

  while (offset < buffer.length) {
    // Look for \r\n\r\n header terminator
    const headerEnd = findHeaderEnd(buffer, offset);
    if (headerEnd === -1) break;

    const headerPart = decoder.decode(buffer.subarray(offset, headerEnd));
    const match = /Content-Length:\s*(\d+)/i.exec(headerPart);
    if (!match) break;

    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4; // Skip \r\n\r\n
    const bodyEnd = bodyStart + contentLength;

    // Check if we have the full body (in bytes)
    if (buffer.length < bodyEnd) break;

    const body = decoder.decode(buffer.subarray(bodyStart, bodyEnd));
    try {
      const parsed = JSON.parse(body) as JsonRpcMessage;
      messages.push(parsed);
    } catch {
      // Invalid JSON, skip this message
    }

    offset = bodyEnd;
  }

  // Create a new array for remaining bytes to ensure ArrayBuffer type
  const remainingLength = buffer.length - offset;
  const remaining = new Uint8Array(remainingLength);
  remaining.set(buffer.subarray(offset));

  return { messages, remaining };
};

/**
 * Find the index of \r\n\r\n in a byte array starting from offset.
 */
const findHeaderEnd = (buffer: Uint8Array, offset: number): number => {
  const CR = 13; // \r
  const LF = 10; // \n
  for (let i = offset; i < buffer.length - 3; i++) {
    if (
      buffer[i] === CR &&
      buffer[i + 1] === LF &&
      buffer[i + 2] === CR &&
      buffer[i + 3] === LF
    ) {
      return i;
    }
  }
  return -1;
};

/**
 * Concatenate two Uint8Arrays.
 */
const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> => {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
};

/**
 * Parse LSP messages from a ReadableStream.
 * Uses Stream.mapAccum to maintain buffer state across chunks.
 */
const parseMessages = (stdout: ReadableStream<Uint8Array>) =>
  Stream.fromReadableStream({
    evaluate: () => stdout,
    onError: (cause) => new JsonRpcParseError({ cause }),
  }).pipe(
    Stream.mapAccum(
      () => new Uint8Array(0) as Uint8Array<ArrayBuffer>,
      (buffer, chunk): [Uint8Array<ArrayBuffer>, JsonRpcMessage[]] => {
        const combined = concatBytes(buffer, chunk);
        const { messages, remaining } = parseBuffer(combined);
        return [remaining, messages];
      },
    ),
  );

/**
 * A JSON-RPC connection over stdio.
 */
export interface JsonRpcConnection {
  /**
   * Send a request and wait for a response.
   */
  readonly request: <A>(
    method: string,
    params: unknown,
  ) => Effect.Effect<A, JsonRpcProtocolError>;

  /**
   * Send a notification (no response expected).
   */
  readonly notify: (method: string, params: unknown) => Effect.Effect<void>;

  /**
   * Register a handler for server notifications.
   */
  readonly onNotification: (
    method: string,
    handler: (params: unknown) => Effect.Effect<void>,
  ) => Effect.Effect<void>;

  /**
   * Shutdown the connection.
   */
  readonly shutdown: Effect.Effect<void>;
}

/**
 * Create a JSON-RPC connection from a subprocess.
 */
export const make = (proc: Subprocess) =>
  Effect.gen(function* () {
    // Pending requests: id -> Deferred<response>
    const pending = yield* Ref.make(
      HashMap.empty<number, Deferred.Deferred<unknown, JsonRpcProtocolError>>(),
    );
    const nextId = yield* Ref.make(0);

    // Notification handlers
    const notificationHandlers = yield* Ref.make(
      HashMap.empty<string, (params: unknown) => Effect.Effect<void>>(),
    );

    // Background fiber reading stdout
    const reader = yield* parseMessages(
      proc.stdout as ReadableStream<Uint8Array>,
    ).pipe(
      Stream.runForEach((msg) =>
        Effect.gen(function* () {
          if ("id" in msg && ("result" in msg || "error" in msg)) {
            // Response to our request
            const response = msg as JsonRpcResponse;
            const maybeDeferred = yield* Ref.get(pending).pipe(
              Effect.map((m) => HashMap.get(m, response.id)),
            );

            if (Option.isSome(maybeDeferred)) {
              if (response.error) {
                yield* Deferred.fail(
                  maybeDeferred.value,
                  new JsonRpcProtocolError({
                    code: response.error.code,
                    message: response.error.message,
                    data: response.error.data,
                  }),
                );
              } else {
                yield* Deferred.succeed(maybeDeferred.value, response.result);
              }
              // Clean up the pending request
              yield* Ref.update(pending, (m) => HashMap.remove(m, response.id));
            }
          } else if ("method" in msg && !("id" in msg)) {
            // Notification from server
            const notification = msg as JsonRpcNotification;
            const maybeHandler = yield* Ref.get(notificationHandlers).pipe(
              Effect.map((m) => HashMap.get(m, notification.method)),
            );

            if (Option.isSome(maybeHandler)) {
              yield* maybeHandler.value(notification.params);
            }
          }
        }),
      ),
      Effect.catch((e) => Effect.logWarning(`JSON-RPC reader error: ${e}`)),
      Effect.forkDetach,
    );

    const connection: JsonRpcConnection = {
      request: <A>(method: string, params: unknown) =>
        Effect.gen(function* () {
          const id = yield* Ref.getAndUpdate(nextId, (n) => n + 1);
          const deferred = yield* Deferred.make<A, JsonRpcProtocolError>();
          yield* Ref.update(pending, (m) =>
            HashMap.set(
              m,
              id,
              deferred as Deferred.Deferred<unknown, JsonRpcProtocolError>,
            ),
          );

          yield* Effect.sync(() => {
            const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
            const stdin = proc.stdin;
            if (stdin && typeof stdin === "object" && "write" in stdin) {
              (stdin as { write: (data: Uint8Array) => void }).write(
                encodeMessage(msg),
              );
            }
          });

          return yield* Deferred.await(deferred);
        }),

      notify: (method: string, params: unknown) =>
        Effect.sync(() => {
          const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
          const stdin = proc.stdin;
          if (stdin && typeof stdin === "object" && "write" in stdin) {
            (stdin as { write: (data: Uint8Array) => void }).write(
              encodeMessage(msg),
            );
          }
        }),

      onNotification: (
        method: string,
        handler: (params: unknown) => Effect.Effect<void>,
      ) =>
        Ref.update(notificationHandlers, (m) =>
          HashMap.set(m, method, handler),
        ),

      shutdown: Effect.gen(function* () {
        yield* Fiber.interrupt(reader);
        yield* Effect.sync(() => proc.kill());
      }),
    };

    return connection;
  });
