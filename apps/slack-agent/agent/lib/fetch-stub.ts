/**
 * Test-only `globalThis.fetch` seam. Not imported by any production module.
 *
 * Every outbound call in this app goes through the global `fetch` (Maple's
 * resolve endpoint, Slack's Web API, Slack's upload URL), so swapping the
 * global is the one seam that covers all of them without threading an injected
 * client through code that has no other reason to take one.
 */

export interface StubbedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: BodyInit | null | undefined;
}

export interface FetchStub {
  readonly calls: StubbedCall[];
  respond: (url: string, call: StubbedCall) => Response | Promise<Response>;
  /** Restores the real `fetch`. */
  restore(): void;
}

/**
 * Installs a stub over `globalThis.fetch` and records every call. Call
 * `restore()` in `afterEach` (or restore the captured original yourself).
 */
export function installFetchStub(
  respond: (url: string, call: StubbedCall) => Response | Promise<Response>,
): FetchStub {
  const realFetch = globalThis.fetch;
  const calls: StubbedCall[] = [];
  const stub: FetchStub = {
    calls,
    respond,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: StubbedCall = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: init?.body,
    };
    calls.push(call);
    return stub.respond(url, call);
  }) as typeof fetch;
  return stub;
}
