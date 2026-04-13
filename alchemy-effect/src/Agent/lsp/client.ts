import type { Subprocess } from "bun";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import { make as makeJsonRpc } from "./jsonrpc.ts";

/**
 * LSP Position (0-indexed line and character)
 */
export const Position = S.Struct({
  line: S.Number,
  character: S.Number,
});
export type Position = S.Schema.Type<typeof Position>;

/**
 * LSP Range (start and end positions)
 */
export const Range = S.Struct({
  start: Position,
  end: Position,
});
export type Range = S.Schema.Type<typeof Range>;

/**
 * LSP Diagnostic severity
 */
export const DiagnosticSeverity = {
  Error: 1,
  Warning: 2,
  Information: 3,
  Hint: 4,
} as const;

/**
 * LSP Diagnostic
 */
export const Diagnostic = S.Struct({
  range: Range,
  severity: S.optional(S.Number),
  message: S.String,
  source: S.optional(S.String),
  code: S.optional(S.Union([S.String, S.Number])),
});
export type Diagnostic = S.Schema.Type<typeof Diagnostic>;

/**
 * publishDiagnostics notification params
 */
const PublishDiagnosticsParams = S.Struct({
  uri: S.String,
  diagnostics: S.Array(Diagnostic),
});

/**
 * A single LSP client connected to one server.
 */
export interface LSPClient {
  readonly id: string;

  /**
   * Notify the server that a file has changed.
   */
  readonly notifyFileChanged: (
    path: string,
    content: string,
  ) => Effect.Effect<void>;

  /**
   * Wait for diagnostics for a file with debouncing.
   */
  readonly waitForDiagnostics: (
    path: string,
    timeout?: number,
  ) => Effect.Effect<Diagnostic[]>;

  /**
   * Get current diagnostics for a file.
   */
  readonly getDiagnostics: (path: string) => Effect.Effect<Diagnostic[]>;

  /**
   * Register a callback for when diagnostics are received.
   */
  readonly onDiagnostics: (
    callback: (uri: string, diagnostics: Diagnostic[]) => Effect.Effect<void>,
  ) => Effect.Effect<void>;

  /**
   * Shutdown the client.
   */
  readonly shutdown: Effect.Effect<void>;
}

/**
 * Create an LSP client from a subprocess.
 */
export const makeLSPClient = (id: string, proc: Subprocess, root: string) =>
  Effect.gen(function* () {
    const rpc = yield* makeJsonRpc(proc);

    // Diagnostics storage: uri -> Diagnostic[]
    const diagnosticsMap = yield* Ref.make(
      HashMap.empty<string, Diagnostic[]>(),
    );

    // PubSub for diagnostic events
    const diagnosticsPubSub = yield* PubSub.unbounded<{ uri: string }>();

    // Track open files and their versions
    const openFiles = yield* Ref.make(HashMap.empty<string, number>());

    // External diagnostic callbacks
    const diagnosticCallbacks = yield* Ref.make<
      Array<(uri: string, diagnostics: Diagnostic[]) => Effect.Effect<void>>
    >([]);

    // Handle publishDiagnostics notifications
    yield* rpc.onNotification(
      "textDocument/publishDiagnostics",
      (params: unknown) =>
        Effect.gen(function* () {
          const decoded = yield* S.decodeUnknownEffect(
            PublishDiagnosticsParams,
          )(params).pipe(Effect.catch(() => Effect.succeed(null)));

          if (!decoded) return;

          // Convert readonly array to mutable for storage
          const diagnostics = [...decoded.diagnostics] as Diagnostic[];

          yield* Ref.update(diagnosticsMap, (m) =>
            HashMap.set(m, decoded.uri, diagnostics),
          );

          yield* PubSub.publish(diagnosticsPubSub, { uri: decoded.uri });

          // Call external callbacks
          const callbacks = yield* Ref.get(diagnosticCallbacks);
          yield* Effect.forEach(
            callbacks,
            (cb) => cb(decoded.uri, diagnostics),
            { concurrency: "unbounded" },
          ).pipe(Effect.catch(() => Effect.void));
        }),
    );

    // LSP initialize handshake
    yield* rpc.request("initialize", {
      processId: process.pid,
      rootUri: `file://${root}`,
      capabilities: {
        textDocument: {
          synchronization: {
            didOpen: true,
            didChange: true,
            willSave: false,
            willSaveWaitUntil: false,
            didSave: false,
          },
          publishDiagnostics: {
            relatedInformation: true,
          },
        },
      },
    });

    yield* rpc.notify("initialized", {});

    return {
      id,

      notifyFileChanged: (path: string, content: string) =>
        Effect.gen(function* () {
          const uri = `file://${path}`;
          const maybeVersion = yield* Ref.get(openFiles).pipe(
            Effect.map((m) => HashMap.get(m, path)),
          );

          if (Option.isNone(maybeVersion)) {
            // File not open yet, send didOpen
            yield* rpc.notify("textDocument/didOpen", {
              textDocument: {
                uri,
                languageId: getLanguageId(path),
                version: 0,
                text: content,
              },
            });
            yield* Ref.update(openFiles, (m) => HashMap.set(m, path, 0));
          } else {
            // File already open, send didChange with incremented version
            const newVersion = maybeVersion.value + 1;
            yield* rpc.notify("textDocument/didChange", {
              textDocument: { uri, version: newVersion },
              contentChanges: [{ text: content }],
            });
            yield* Ref.update(openFiles, (m) =>
              HashMap.set(m, path, newVersion),
            );
          }
        }),

      waitForDiagnostics: (path: string, timeout = 3000) =>
        Effect.gen(function* () {
          const uri = `file://${path}`;

          // Wait for diagnostics with 150ms debounce, scoped
          yield* Effect.scoped(
            Effect.gen(function* () {
              const subscription = yield* PubSub.subscribe(diagnosticsPubSub);
              yield* Stream.fromSubscription(subscription).pipe(
                Stream.filter((e) => e.uri === uri),
                Stream.debounce(150),
                Stream.take(1),
                Stream.runDrain,
              );
            }),
          ).pipe(
            Effect.timeout(timeout),
            Effect.catch(() => Effect.void),
          );

          // Return diagnostics for this file
          const diags = yield* Ref.get(diagnosticsMap).pipe(
            Effect.map((m) => HashMap.get(m, uri)),
          );

          return Option.getOrElse(diags, () => [] as Diagnostic[]);
        }),

      getDiagnostics: (path: string) =>
        Effect.gen(function* () {
          const uri = `file://${path}`;
          const diags = yield* Ref.get(diagnosticsMap).pipe(
            Effect.map((m) => HashMap.get(m, uri)),
          );
          return Option.getOrElse(diags, () => []);
        }),

      onDiagnostics: (
        callback: (
          uri: string,
          diagnostics: Diagnostic[],
        ) => Effect.Effect<void>,
      ) => Ref.update(diagnosticCallbacks, (cbs) => [...cbs, callback]),

      shutdown: Effect.gen(function* () {
        yield* rpc
          .request("shutdown", null)
          .pipe(Effect.catch(() => Effect.void));
        yield* rpc.notify("exit", null);
        yield* rpc.shutdown;
      }),
    };
  });

/**
 * Get LSP language ID from file path.
 */
const getLanguageId = (path: string): string => {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
    case "mtsx":
    case "ctsx":
      return "typescriptreact";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "javascriptreact";
    case "json":
      return "json";
    case "vue":
      return "vue";
    case "svelte":
      return "svelte";
    case "astro":
      return "astro";
    default:
      return "plaintext";
  }
};
