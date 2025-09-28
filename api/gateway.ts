/* /api/gateway.ts */
export const runtime = "edge";

import {
  PROXIES,
  DEFAULT_TIMEOUT,
  MAX_RESPONSE_SIZE,
  buildForwardHeaders,
  buildUpstreamURL,
  categorizeError,
  createCorsHeaders,
  createErrorResponse,
  fetchWithRetry,
  getRequestId,
  isStreamRequested,
  logDebug,
  logError,
  logInfo,
  logWarn,
  processResponseHeaders,
  sanitizePath,
  SizeLimitExceededError,
} from "./config";

const EDGE_FIRST_BYTE_DEADLINE = 23_000;
const EDGE_RESPONSE_LIMIT = MAX_RESPONSE_SIZE;
const RETRY_STATUS_CODES = [408, 409, 425, 429, 500, 502, 503, 504];
const BACKGROUND_PATH = "/background";

interface ParsedRoute {
  service: string;
  userPath: string;
  search: string;
  url: URL;
  originalPath: string;
}

function ensureAbsoluteURL(req: Request, headers: Headers) {
  if (req.url.startsWith("http://") || req.url.startsWith("https://")) {
    return new URL(req.url);
  }
  const host = headers.get("host") ?? "localhost";
  const proto = headers.get("x-forwarded-proto") ?? "https";
  return new URL(req.url.startsWith("/") ? req.url : `/${req.url}`, `${proto}://${host}`);
}

function parseRoute(req: Request, headers: Headers): ParsedRoute | null {
  const url = ensureAbsoluteURL(req, headers);

  const serviceParam = url.searchParams.get("service");
  const pathParam = url.searchParams.get("path");
  if (serviceParam) {
    const cleaned = new URLSearchParams(url.searchParams);
    cleaned.delete("service");
    cleaned.delete("path");

    const normalizedPath = pathParam
      ? sanitizePath(decodeURIComponent(pathParam).split("/"))
      : "";

    return {
      service: serviceParam,
      userPath: normalizedPath,
      search: cleaned.toString() ? `?${cleaned.toString()}` : "",
      url,
      originalPath: `/gateway/${serviceParam}${normalizedPath ? `/${normalizedPath}` : ""}`,
    };
  }

  let pathname = url.pathname;
  if (pathname.startsWith("/api/")) pathname = pathname.slice(4);

  const segments = pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (segments[0] !== "gateway" || segments.length < 3) return null;

  const service = segments[1];
  const userPath = sanitizePath(segments.slice(2));

  return {
    service,
    userPath,
    search: url.search,
    url,
    originalPath: pathname,
  };
}

function isJsonLike(contentType: string | null) {
  return !!contentType && contentType.toLowerCase().startsWith("application/json");
}

async function detectStreamIntent(req: Request, headers: Headers) {
  const contentType = headers.get("content-type");
  if (!isJsonLike(contentType)) {
    return isStreamRequested(headers);
  }

  try {
    const parsed = await req.clone().json();
    return isStreamRequested(headers, parsed);
  } catch {
    return isStreamRequested(headers);
  }
}

function resolveEdgeTimeout(service: string) {
  const proxy = PROXIES[service];
  const specified = proxy?.timeout ?? DEFAULT_TIMEOUT;
  return Math.min(specified, EDGE_FIRST_BYTE_DEADLINE);
}

function buildBackgroundHeaders(source: Headers, extras: Record<string, string>, hasBody: boolean) {
  const whitelist = new Set([
    "accept",
    "accept-language",
    "content-type",
    "content-length",
    "authorization",
    "user-agent",
    "x-api-key",
    "x-goog-api-key",
  ]);

  const headers = new Headers();
  for (const [key, value] of source.entries()) {
    const lower = key.toLowerCase();
    if (whitelist.has(lower) || lower.startsWith("x-")) {
      headers.set(key, value);
    }
  }

  Object.entries(extras).forEach(([k, v]) => headers.set(k, v));
  if (!hasBody) headers.delete("content-length");
  headers.set("cache-control", "no-store");
  return headers;
}

function limitStreamSize(stream: ReadableStream<Uint8Array>, limit: number, reqId: string) {
  const reader = stream.getReader();
  let total = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      total += value.byteLength;
      if (total > limit) {
        controller.error(new SizeLimitExceededError(limit, total));
        await reader.cancel("size_exceeded");
        logWarn("响应超过限制，终止传输", { reqId, total, limit });
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

async function forwardViaEdge(
  req: Request,
  ctx: { service: string; userPath: string; search: string; reqId: string; headers: Headers; streaming: boolean }
) {
  const { service, userPath, search, reqId, headers, streaming } = ctx;
  const proxy = PROXIES[service];
  if (!proxy) {
    return createErrorResponse(404, `服务 ${service} 未配置`, reqId);
  }

  const upstreamURL = buildUpstreamURL(proxy.host, proxy.basePath, userPath, search);
  const forwardHeaders = buildForwardHeaders(headers, proxy);
  forwardHeaders.set("X-Request-Id", reqId);

  const timeout = resolveEdgeTimeout(service);
  logDebug("Edge 直连上游", { reqId, service, upstreamURL, timeout, streaming });

  try {
    const response = await fetchWithRetry(
      upstreamURL,
      {
        method: req.method,
        headers: forwardHeaders,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      },
      {
        retries: proxy.retryable ? 2 : 0,
        retryableMethods: proxy.retryableMethods ?? ["GET", "HEAD", "OPTIONS", "POST"],
        retryStatusCodes: RETRY_STATUS_CODES,
        timeoutPerAttempt: timeout,
        baseDelay: 200,
        maxDelay: 1500,
        jitter: 0.25,
        reqId,
        label: `${service}-edge`,
      }
    );

    const limit = proxy.maxResponseSize ?? EDGE_RESPONSE_LIMIT;
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > limit) {
      logWarn("响应 Content-Length 超限", { reqId, service, limit, contentLength });
      return createErrorResponse(413, "响应体超过 Edge 允许的大小限制", reqId, {
        limit,
        content_length: Number(contentLength),
      });
    }

    const headersOut = processResponseHeaders(response.headers, reqId);
    headersOut.set("X-Upstream-Status", `${response.status}`);

    if (!response.body) {
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: headersOut,
      });
    }

    const guardedStream = limitStreamSize(response.body, limit, reqId);
    return new Response(guardedStream, {
      status: response.status,
      statusText: response.statusText,
      headers: headersOut,
    });
  } catch (err) {
    if (err instanceof SizeLimitExceededError) {
      return createErrorResponse(413, "响应体超过 Edge 允许的大小限制", reqId, {
        limit: err.maxBytes,
        actual: err.actualBytes,
      });
    }
    const { status, message } = categorizeError(err as Error);
    logError("Edge 转发失败", { reqId, service, status, message });
    return createErrorResponse(status, message, reqId, { service });
  }
}

async function handoffToBackground(
  req: Request,
  ctx: { service: string; userPath: string; search: string; reqId: string; url: URL; headers: Headers }
) {
  const { service, userPath, search, reqId, url, headers } = ctx;
  const proxy = PROXIES[service];
  if (!proxy) {
    return createErrorResponse(404, `服务 ${service} 未配置`, reqId);
  }

  const bodyBuffer =
    req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const hasBody = bodyBuffer !== undefined;

  const relayHeaders = buildBackgroundHeaders(
    headers,
    {
      "x-gateway-target-service": service,
      "x-gateway-target-path": userPath,
      "x-request-id": reqId,
    },
    hasBody
  );

  if (search) {
    relayHeaders.set("x-gateway-target-query", search.startsWith("?") ? search.slice(1) : search);
  }
  relayHeaders.set("x-gateway-dispatcher", "edge");

  const backgroundURL = new URL(BACKGROUND_PATH, url.origin);
  logInfo("Edge 分流至 Background", {
    reqId,
    service,
    target: backgroundURL.toString(),
  });

  const response = await fetch(backgroundURL.toString(), {
    method: req.method,
    headers: relayHeaders,
    body: hasBody ? new Uint8Array(bodyBuffer!) : undefined,
    cache: "no-store",
  });

  const headersOut = processResponseHeaders(response.headers, reqId);
  headersOut.set("X-Background-Proxy", "1");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: headersOut,
  });
}

export default async function handler(req: Request) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: createCorsHeaders() });
  }

  const incomingHeaders = new Headers(req.headers);
  const reqId = getRequestId(incomingHeaders);

  const route = parseRoute(req, incomingHeaders);
  if (!route) {
    return createErrorResponse(404, "未匹配到网关路径", reqId);
  }

  const { service, userPath, search, url, originalPath } = route;
  if (!PROXIES[service]) {
    return createErrorResponse(404, `服务 ${service} 未配置`, reqId);
  }

  logInfo("Edge 收到请求", {
    reqId,
    method: req.method,
    service,
    path: originalPath,
    search,
  });

  const streaming = await detectStreamIntent(req, incomingHeaders);
  const stayOnEdge = streaming;

  logDebug("分流决策", {
    reqId,
    method: req.method,
    streaming,
    stayOnEdge,
  });

  if (!stayOnEdge) {
    return handoffToBackground(req, {
      service,
      userPath,
      search,
      reqId,
      url,
      headers: incomingHeaders,
    });
  }

  return forwardViaEdge(req, {
    service,
    userPath,
    search,
    reqId,
    headers: incomingHeaders,
    streaming,
  });
}
