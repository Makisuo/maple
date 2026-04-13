import type {
  LambdaFunctionURLEvent,
  LambdaFunctionURLResult,
} from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Scope } from "effect/Scope";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Http from "../../Http.ts";

export const isFunctionURLEvent = (
  event: any,
): event is LambdaFunctionURLEvent => {
  return event.requestContext?.http?.method !== undefined;
};

export const makeFunctionHttpHandler = <Req>(handler: Http.HttpEffect<Req>) => {
  const safeHandler = Http.safeHttpEffect(handler);
  return (event: any) => {
    if (isFunctionURLEvent(event)) {
      const request = HttpServerRequest.fromWeb(toWebRequest(event)).modify({
        remoteAddress: Option.some(event.requestContext.http.sourceIp),
      });
      return safeHandler.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.flatMap(toLambdaFunctionURLResult),
      ) as Effect.Effect<
        LambdaFunctionURLResult,
        never,
        Exclude<
          Effect.Services<typeof handler>,
          HttpServerRequest.HttpServerRequest | Scope
        >
      >;
    }
  };
};

const toWebRequest = (event: LambdaFunctionURLEvent): Request => {
  const protocol =
    event.headers["x-forwarded-proto"] ??
    event.requestContext.http.protocol ??
    "https";
  const host = event.headers.host ?? event.requestContext.domainName;
  const url = `${protocol}://${host}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`;
  const method = event.requestContext.http.method;
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers)) {
    if (value !== undefined) {
      headers.set(key, value);
    }
  }
  if (event.cookies?.length) {
    headers.set("cookie", event.cookies.join("; "));
  }

  let body: string | ArrayBuffer | undefined;
  if (event.body !== undefined) {
    body = event.isBase64Encoded
      ? Uint8Array.from(atob(event.body), (c) => c.charCodeAt(0)).buffer
      : event.body;
  }

  return new Request(url, {
    method,
    headers,
    body: body && method !== "GET" && method !== "HEAD" ? body : undefined,
  });
};

const toLambdaFunctionURLResult = (
  response: HttpServerResponse.HttpServerResponse,
): Effect.Effect<LambdaFunctionURLResult> =>
  Effect.gen(function* () {
    const context = yield* Effect.context();
    const webResponse = HttpServerResponse.toWeb(response, { context });
    const headers = new Headers(webResponse.headers);
    const cookies =
      typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];

    headers.delete("set-cookie");

    if (!webResponse.body) {
      return {
        statusCode: webResponse.status,
        headers: Object.fromEntries(headers.entries()),
        cookies: cookies.length > 0 ? cookies : undefined,
      };
    }

    const bytes = new Uint8Array(
      yield* Effect.promise(() => webResponse.arrayBuffer()),
    );
    const isTextual = isTextualContentType(headers.get("content-type"));
    const body =
      bytes.length === 0
        ? undefined
        : isTextual
          ? new TextDecoder().decode(bytes)
          : Buffer.from(bytes).toString("base64");

    return {
      statusCode: webResponse.status,
      headers: Object.fromEntries(headers.entries()),
      body,
      cookies: cookies.length > 0 ? cookies : undefined,
      isBase64Encoded: body !== undefined && !isTextual ? true : undefined,
    };
  });

const isTextualContentType = (contentType: string | null): boolean => {
  if (!contentType) {
    return false;
  }

  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript") ||
    normalized.includes("form-urlencoded")
  );
};
